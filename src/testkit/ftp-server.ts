// The in-process FTP server: node:net on 127.0.0.1, files kept in memory (the tree the memory and
// SFTP servers share), so the real FTP transport runs on any OS without containers (spec #41
// decision 17). Passive mode only (EPSV and PASV), one data connection per transfer. It answers
// like the usual Unix servers: MLSD and MLST when FEAT offers MLST (Pure-FTPd, ProFTPD), else LIST
// in `ls -l` form (vsftpd); RNTO replaces an existing file; SITE CHMOD sets the mode; new files get
// 0644 and new folders 0755 (umask 022).
//
// Options turn features off, to test the transport's fallbacks: no MLST (LIST only), no EPSV
// (PASV only, naming any address), RNTO that refuses to replace, no SITE CHMOD; and act as the
// real servers of the end-to-end tests do (spec #41 decision 17): ProFTPD's MLST that follows a
// link and its refused APPE, a STOR that makes a new file. Faults (story 79):
// a refused login, the nth STOR failing with a given code (a dropped connection drops every
// connection of the server, as a network cut would), the nth RETR dropped after its first chunk,
// a file changed once its size was looked at, slow replies, and an oversized reply (R21).
//
// With `tls` it is an explicit FTPS server (spec #41 decision 8): AUTH TLS upgrades the control
// connection, PBSZ 0 and PROT P protect each data connection, whose TLS session the view
// `dataTls()` tells (resumed from the control's, as servers expect, or new). Without it, AUTH TLS
// is refused, as on a plain FTP server.

import { createServer, type Server, type Socket } from 'node:net';
import { posix } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';
import type { TransportErrorCode } from '../contracts/index.ts';
import { listLine, mlsxLine, mlsxTime } from './ftp-listing.ts';
import type { SessionFaults } from './session-contract-kit.ts';
import {
  childrenOf,
  createTree,
  type Entry,
  hasChildren,
  newFolder,
  parentOf,
  type TreeView,
  writtenFile,
} from './tree.ts';

interface FtpServerOptions {
  /** What PWD gives at login; created empty. Default `/home/deploy`. */
  readonly loginFolder?: string;
  /** The one password it accepts, for user `deploy`. */
  readonly password?: string;
  /** FEAT offers MLST, and MLSD and MLST are answered. Default true. */
  readonly mlsd?: boolean;
  /** EPSV is answered. Default true; without it a client must use PASV. */
  readonly epsv?: boolean;
  /** The address a PASV reply names (R9's test names another one). Default `127.0.0.1`. */
  readonly pasvHost?: string;
  /** RNTO onto an existing file replaces it. Default true; false refuses (550). */
  readonly renameReplaces?: boolean;
  /** SITE CHMOD is answered. Default true; false answers 500, as a server without it does. */
  readonly siteChmod?: boolean;
  /** MLST of a link describes what it points to (550 when dangling), as ProFTPD's. */
  readonly mlstFollowsLinks?: boolean;
  /** APPE is taken. Default true; false answers 451, as ProFTPD without AllowStoreRestart. */
  readonly append?: boolean;
  /**
   * STOR onto an existing file keeps that file and its mode. Default true; false makes a new file
   * (mode 0644), as a server that writes to a hidden name and renames it into place.
   */
  readonly storeKeepsMode?: boolean;
  /** Control connections open at once; one more is greeted with 421 and closed (vsftpd). */
  readonly maxConnections?: number;
  /**
   * Explicit TLS with this key and certificate (tls-certificates.ts: test only). Absent: AUTH TLS
   * is answered 502, as a plain FTP server does.
   */
  readonly tls?: { readonly key: string; readonly cert: string };
  /**
   * Data connections get a TLS context of their own, showing this certificate (same key): they
   * can never resume the control's session, as on a server that does not offer resumption.
   */
  readonly dataCert?: string;
}

/** How a data connection travelled: in clear, or TLS resuming the control's session, or not. */
type DataTls = 'plain' | 'resumed' | 'new-session';

/** The Session faults, plus those only an FTP server has. */
interface FtpFaults extends SessionFaults {
  /** The reply to the next command is a multi-line reply of about `bytes` bytes (R21). */
  longReply(bytes: number): void;
  /** Closes `count` control connections now, the oldest first, as an idle timeout does. */
  closeConnections(count: number): void;
}

export interface FtpServer extends TreeView {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly faults: FtpFaults;
  /** Every command received, in order, with PASS's argument hidden (`PASS ***`). */
  commands(): readonly string[];
  /** The logins accepted. */
  logins(): number;
  /** The control connections open now. */
  openConnections(): number;
  /** The local address each data connection arrived on (R9: always the control's own). */
  dataAddresses(): readonly string[];
  /** How each data connection travelled, in order (spec #41 decision 8: TLS, session resumed). */
  dataTls(): readonly DataTls[];
  /** Resolves once no control connection is open. */
  closed(): Promise<void>;
  stop(): Promise<void>;
}

/** What one control connection knows. */
interface ControlState {
  loggedIn: boolean;
  user: string | undefined;
  cwd: string;
  renameFrom: string | undefined;
  /** The data connection the last EPSV or PASV prepared. */
  data: Promise<Socket> | undefined;
  /** The control connection is TLS (after AUTH TLS). */
  secure: boolean;
  /** PROT P: data connections are TLS too. */
  protect: boolean;
}

const host = '127.0.0.1';

export async function createFtpServer(options: FtpServerOptions = {}): Promise<FtpServer> {
  const tree = createTree(options.loginFolder ?? '/home/deploy');
  const { entries } = tree;
  const user = 'deploy';
  const password = options.password ?? 'ftp-test-password';
  const mlsd = options.mlsd ?? true;
  const epsv = options.epsv ?? true;
  const renameReplaces = options.renameReplaces ?? true;
  const siteChmod = options.siteChmod ?? true;
  const append = options.append ?? true;
  const storeKeepsMode = options.storeKeepsMode ?? true;

  // One context for the control and data connections: its ticket keys let a data connection
  // resume the control's TLS session.
  const context =
    options.tls === undefined
      ? undefined
      : createSecureContext({ key: options.tls.key, cert: options.tls.cert });
  const dataContext =
    options.tls === undefined || options.dataCert === undefined
      ? context
      : createSecureContext({ key: options.tls.key, cert: options.dataCert });

  const commands: string[] = [];
  const dataAddresses: string[] = [];
  const dataTls: DataTls[] = [];
  /** Each control connection, as it was accepted, with the socket it talks on now (TLS or not). */
  const controls = new Map<Socket, Socket>();
  const sockets = new Set<Socket>();
  const listeners = new Set<Server>();
  const timers = new Set<NodeJS.Timeout>();
  const idle: (() => void)[] = [];
  let logins = 0;
  let loginRefused = false;
  let slowMs = 0;
  let stores = 0;
  let retrieves = 0;
  let longReply = 0;
  const armed: { at: number; code: TransportErrorCode }[] = [];
  const drops: number[] = [];
  const changes = new Map<string, Uint8Array>();

  const faults: FtpFaults = {
    failWrite(nth, code) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      armed.push({ at: stores + nth, code });
    },
    dropDuringRead(nth) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      drops.push(retrieves + nth);
    },
    changeDuringRead(path, bytes) {
      changes.set(path, Uint8Array.from(bytes));
    },
    refuseLogin() {
      loginRefused = true;
    },
    slow(ms) {
      slowMs = ms;
    },
    longReply(bytes) {
      longReply = bytes;
    },
    closeConnections(count) {
      for (const control of [...controls.values()].slice(0, count)) {
        control.end('421 Timeout.\r\n');
      }
    },
  };

  /** A network cut: every connection of the server goes at once. */
  const dropAll = (): void => {
    for (const socket of sockets) socket.destroy();
    for (const listener of listeners) listener.close();
    listeners.clear();
  };

  /**
   * The data connection of a passive request: a listener for one connection, then closed. With
   * `protect` (PROT P) the connection is TLS, handed over once its handshake is done.
   */
  const passive = (protect: boolean): { port: Promise<number>; socket: Promise<Socket> } => {
    const listener = createServer();
    listeners.add(listener);
    const socket = new Promise<Socket>((resolve) => {
      listener.once('connection', (data) => {
        sockets.add(data);
        data.on('close', () => sockets.delete(data));
        data.on('error', () => {
          // The client went away mid-transfer: nothing to do here.
        });
        dataAddresses.push(data.localAddress ?? '');
        listeners.delete(listener);
        listener.close();
        if (!protect || dataContext === undefined) {
          dataTls.push('plain');
          resolve(data);
          return;
        }
        const secure = new TLSSocket(data, { isServer: true, secureContext: dataContext });
        secure.on('error', () => {
          // A handshake the client broke off (a certificate it refused): nothing to do here.
        });
        secure.once('secure', () => {
          dataTls.push(secure.isSessionReused() ? 'resumed' : 'new-session');
          resolve(secure);
        });
      });
    });
    const port = new Promise<number>((resolve) => {
      listener.listen(0, host, () => resolve((listener.address() as { port: number }).port));
    });
    return { port, socket };
  };

  /** Every byte the client sends on a data connection, until it closes it. */
  const receive = (data: Socket): Promise<Uint8Array> =>
    new Promise((resolve) => {
      const parts: Buffer[] = [];
      data.on('data', (chunk: Buffer) => parts.push(chunk));
      data.on('close', () => resolve(new Uint8Array(Buffer.concat(parts))));
    });

  const send = (data: Socket, text: string | Uint8Array): Promise<void> =>
    new Promise((resolve) => data.end(text, () => resolve()));

  const onControl = (socket: Socket): void => {
    controls.set(socket, socket);
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.on('error', () => {
      // A client that drops or is dropped: nothing to do on the server side.
    });
    socket.on('close', () => {
      controls.delete(socket);
      sockets.delete(socket);
      if (controls.size === 0) for (const resolve of idle.splice(0)) resolve();
    });
    if (controls.size > (options.maxConnections ?? Number.POSITIVE_INFINITY)) {
      socket.end('421 There are too many connections from your internet address.\r\n');
      return;
    }
    /** The socket replies go on: the accepted one, or its TLS layer after AUTH TLS. */
    let control: Socket = socket;
    const state: ControlState = {
      loggedIn: false,
      user: undefined,
      cwd: tree.loginFolder,
      renameFrom: undefined,
      data: undefined,
      secure: false,
      protect: false,
    };

    /** Writes a reply now, or `slowMs` later (fault `slow`); an oversized one when armed. */
    const reply = (text: string): Promise<void> =>
      new Promise((resolve) => {
        const write = (): void => {
          let long = '';
          if (longReply > 0) {
            // The same reply, made multi-line: its code, `-`, filler lines, then the reply.
            const filler = Array.from(
              { length: Math.ceil(longReply / 64) },
              () => ` ${'x'.repeat(61)}\r\n`,
            );
            long = `${text.slice(0, 3)}-Long reply\r\n${filler.join('')}`;
            longReply = 0;
          }
          if (!control.destroyed) control.write(`${long}${text}\r\n`);
          resolve();
        };
        if (slowMs === 0) return write();
        const timer = setTimeout(() => {
          timers.delete(timer);
          write();
        }, slowMs);
        timers.add(timer);
      });

    const resolvePath = (arg: string): string => {
      const joined = arg.startsWith('/') ? arg : `${state.cwd === '/' ? '' : state.cwd}/${arg}`;
      const out: string[] = [];
      for (const segment of joined.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') out.pop();
        else out.push(segment);
      }
      return `/${out.join('/')}`;
    };

    /** The data connection EPSV or PASV prepared, or a 425 reply when there is none. */
    const takeData = async (): Promise<Socket | undefined> => {
      const data = state.data;
      state.data = undefined;
      if (data === undefined) await reply('425 Use PASV or EPSV first.');
      return data === undefined ? undefined : await data;
    };

    const store = async (verb: 'STOR' | 'APPE', path: string): Promise<void> => {
      if (verb === 'STOR') {
        const fault = takeFault(armed, ++stores);
        if (fault === 'connection-lost') return dropAll();
        if (fault === 'timeout') return; // never answered
        if (fault !== undefined) {
          (await takeData())?.destroy();
          return reply(replyFor(fault));
        }
      }
      if (verb === 'APPE' && !append) {
        (await takeData())?.destroy();
        return reply(`451 ${path}: Append/Restart not permitted, try again`);
      }
      const entry = entries.get(path);
      if (entries.get(parentOf(path))?.kind !== 'folder') {
        (await takeData())?.destroy();
        return reply('553 Could not create file: No such file or directory.');
      }
      if (entry !== undefined && entry.kind !== 'file') {
        (await takeData())?.destroy();
        return reply('550 Could not create file: Is a directory.');
      }
      const data = await takeData();
      if (data === undefined) return;
      // STOR truncates at once, as open(2) with O_TRUNC; a new file gets 0644 (umask 022).
      if (verb === 'STOR' || entry === undefined) {
        entries.set(path, writtenFile(storeKeepsMode ? entry : undefined, new Uint8Array()));
      }
      await reply('150 Ok to send data.');
      const received = await receive(data);
      const before = entries.get(path);
      if (before?.kind !== 'file') return reply('451 File vanished.');
      const bytes = new Uint8Array(before.bytes.length + received.length);
      bytes.set(before.bytes);
      bytes.set(received, before.bytes.length);
      // The mode the file had when its first byte arrived (R17), as the SFTP server records it.
      const firstByteMode = before.bytes.length > 0 ? before.firstByteMode : before.mode;
      const written = writtenFile(before, bytes);
      entries.set(
        path,
        bytes.length > 0 && firstByteMode !== undefined ? { ...written, firstByteMode } : written,
      );
      await reply('226 Transfer complete.');
    };

    const retrieve = async (path: string): Promise<void> => {
      const entry = entries.get(path);
      if (entry === undefined || entry.kind !== 'file') {
        (await takeData())?.destroy();
        return reply(
          entry === undefined
            ? '550 Failed to open file: No such file or directory.'
            : '550 Failed to open file: Not a regular file.',
        );
      }
      const drop = drops.indexOf(++retrieves);
      if (drop !== -1) drops.splice(drop, 1);
      // Fault changeDuringRead: the size was looked at (SIZE or MLST); now the file changes.
      const change = changes.get(path);
      if (change !== undefined) {
        changes.delete(path);
        entries.set(path, { ...entry, bytes: change });
      }
      const data = await takeData();
      if (data === undefined) return;
      await reply('150 Opening BINARY mode data connection.');
      const bytes = (entries.get(path) as Extract<Entry, { kind: 'file' }>).bytes;
      if (drop !== -1) {
        // Fault dropDuringRead: one chunk arrives, then the connection drops.
        data.write(bytes.subarray(0, 16 * 1024), () => dropAll());
        return;
      }
      await send(data, bytes);
      await reply('226 Transfer complete.');
    };

    /** LIST [-a] [path] in `ls -l` form, MLSD [path] in facts. */
    const listing = async (verb: 'LIST' | 'MLSD', arg: string): Promise<void> => {
      let rest = arg;
      let all = false;
      while (verb === 'LIST' && /^-\w+(?: |$)/.test(rest)) {
        all ||= /^-\w*a/.test(rest);
        rest = rest.replace(/^-\w+ ?/, '');
      }
      const path = resolvePath(rest);
      const entry = entries.get(path);
      if (entry === undefined || (verb === 'MLSD' && entry.kind !== 'folder')) {
        (await takeData())?.destroy();
        return reply('550 Could not list: No such file or directory.');
      }
      const now = Math.floor(Date.now() / 1000);
      let lines: string[];
      if (entry.kind !== 'folder') {
        lines = [listLine(entry, path.slice(path.lastIndexOf('/') + 1), now)];
      } else if (verb === 'MLSD') {
        lines = [
          mlsxLine(entry, '.', 'cdir'),
          mlsxLine(entries.get(parentOf(path)) ?? entry, '..', 'pdir'),
          ...childrenOf(entries, path).map(([name, child]) => mlsxLine(child, name)),
        ];
      } else {
        const children = childrenOf(entries, path).filter(([name]) => all || !name.startsWith('.'));
        const dots: [string, Entry][] = all
          ? [
              ['.', entry],
              ['..', entries.get(parentOf(path)) ?? entry],
            ]
          : [];
        lines = [
          `total ${children.length}`,
          ...[...dots, ...children].map(([name, child]) => listLine(child, name, now)),
        ];
      }
      const data = await takeData();
      if (data === undefined) return;
      await reply('150 Here comes the directory listing.');
      await send(data, lines.map((line) => `${line}\r\n`).join(''));
      await reply('226 Directory send OK.');
    };

    const handle = async (line: string): Promise<void> => {
      const space = line.indexOf(' ');
      const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase();
      const arg = space === -1 ? '' : line.slice(space + 1);
      commands.push(verb === 'PASS' ? 'PASS ***' : line);
      if (verb === 'USER') {
        state.user = arg;
        return reply('331 Please specify the password.');
      }
      if (verb === 'PASS') {
        if (loginRefused || state.user !== user || arg !== password) {
          return reply('530 Login incorrect.');
        }
        state.loggedIn = true;
        logins++;
        return reply('230 Login successful.');
      }
      if (verb === 'QUIT') {
        await reply('221 Goodbye.');
        control.end();
        return;
      }
      if (verb === 'FEAT') {
        const features = [epsv ? ' EPSV' : undefined, ' PASV', ' SIZE', ' MDTM', ' UTF8'];
        if (mlsd) features.push(' MLST type*;size*;modify*;UNIX.mode*;UNIX.owner*;');
        if (context !== undefined) features.push(' AUTH TLS', ' PBSZ', ' PROT');
        return reply(['211-Features:', ...features.filter(Boolean), '211 End'].join('\r\n'));
      }
      if (verb === 'AUTH') {
        if (context === undefined || arg.toUpperCase() !== 'TLS' || state.secure) {
          return reply('502 Command not implemented.');
        }
        await reply('234 Proceed with negotiation.');
        secureControl(context);
        return;
      }
      if (verb === 'PBSZ') {
        return reply(state.secure ? '200 PBSZ=0' : '503 PBSZ needs a secure connection.');
      }
      if (verb === 'PROT') {
        if (!state.secure) return reply('503 PROT needs a secure connection.');
        const level = arg.toUpperCase();
        if (level !== 'P' && level !== 'C') return reply('504 Protection level not supported.');
        state.protect = level === 'P';
        return reply(`200 Protection level set to ${level}.`);
      }
      if (verb === 'OPTS') return reply('200 Always in UTF8 mode.');
      if (verb === 'SYST') return reply('215 UNIX Type: L8');
      if (!state.loggedIn) return reply('530 Please login with USER and PASS.');
      const path = resolvePath(arg);
      const entry = entries.get(path);
      switch (verb) {
        case 'TYPE':
        case 'STRU':
        case 'MODE':
        case 'NOOP':
          return reply('200 Ok.');
        case 'PWD':
          return reply(`257 "${state.cwd}" is the current directory`);
        case 'CWD':
          if (entry?.kind !== 'folder') return reply('550 Failed to change directory.');
          state.cwd = path;
          return reply('250 Directory successfully changed.');
        case 'CDUP':
          state.cwd = parentOf(state.cwd);
          return reply('250 Directory successfully changed.');
        case 'EPSV': {
          if (!epsv) return reply('502 Command not implemented.');
          const { port, socket: data } = passive(state.protect);
          state.data = data;
          return reply(`229 Entering Extended Passive Mode (|||${await port}|)`);
        }
        case 'PASV': {
          const { port, socket: data } = passive(state.protect);
          state.data = data;
          const p = await port;
          const named = (options.pasvHost ?? host).replaceAll('.', ',');
          return reply(`227 Entering Passive Mode (${named},${p >> 8},${p & 255}).`);
        }
        case 'STOR':
        case 'APPE':
          return store(verb, path);
        case 'RETR':
          return retrieve(path);
        case 'LIST':
        case 'MLSD':
          return listing(verb, arg);
        case 'MLST': {
          if (!mlsd) return reply('502 Command not implemented.');
          // ProFTPD's MLST describes what a link points to, and nothing for a dangling one.
          const described =
            options.mlstFollowsLinks === true && entry?.kind === 'link'
              ? entries.get(posix.resolve(parentOf(path), entry.target))
              : entry;
          if (described === undefined) return reply('550 No such file or directory.');
          return reply(`250- Listing ${path}\r\n ${mlsxLine(described, path)}\r\n250 End`);
        }
        case 'SIZE':
          if (entry?.kind !== 'file') return reply('550 Could not get file size.');
          return reply(`213 ${entry.bytes.length}`);
        case 'MDTM':
          if (entry === undefined) return reply('550 Could not get file modification time.');
          return reply(`213 ${mlsxTime(entry.mtime)}`);
        case 'DELE':
          if (entry === undefined) return reply('550 Delete operation failed: No such file.');
          if (entry.kind === 'folder') return reply('550 Delete operation failed: Is a directory.');
          entries.delete(path);
          return reply('250 Delete operation successful.');
        case 'MKD':
          if (entries.get(parentOf(path))?.kind !== 'folder') {
            return reply('550 Create directory operation failed: No such file or directory.');
          }
          if (entry !== undefined) return reply('550 Create directory operation failed: Exists.');
          entries.set(path, newFolder());
          return reply(`257 "${path}" created`);
        case 'RMD':
          if (entry?.kind !== 'folder' || hasChildren(entries, path)) {
            return reply('550 Remove directory operation failed.');
          }
          entries.delete(path);
          return reply('250 Remove directory operation successful.');
        case 'RNFR':
          if (entry === undefined) return reply('550 RNFR command failed.');
          state.renameFrom = path;
          return reply('350 Ready for RNTO.');
        case 'RNTO': {
          const from = state.renameFrom;
          state.renameFrom = undefined;
          const moving = from === undefined ? undefined : entries.get(from);
          if (from === undefined || moving === undefined) return reply('503 RNFR required first.');
          const replacing = entry !== undefined && (entry.kind === 'folder' || !renameReplaces);
          if (entries.get(parentOf(path))?.kind !== 'folder' || replacing) {
            return reply('550 Rename failed.');
          }
          entries.delete(from);
          entries.set(path, moving);
          return reply('250 Rename successful.');
        }
        case 'SITE':
          return site(arg);
        default:
          return reply('502 Command not implemented.');
      }
    };

    /** SITE CHMOD <octal> <path>, the only SITE command. */
    const site = (arg: string): Promise<void> => {
      const chmod = /^CHMOD ([0-7]{1,4}) (.+)$/i.exec(arg);
      if (!siteChmod || chmod === null) return reply('500 Unknown SITE command.');
      const path = resolvePath(chmod[2] ?? '');
      const entry = entries.get(path);
      if (entry === undefined) return reply('550 SITE CHMOD command failed.');
      entries.set(path, { ...entry, mode: Number.parseInt(chmod[1] ?? '', 8) & 0o7777 });
      return reply('200 SITE CHMOD command ok.');
    };

    // Commands are handled one at a time, in the order they arrive.
    let buffer = '';
    let queue = Promise.resolve();
    const onData = (chunk: string): void => {
      buffer += chunk;
      for (let end = buffer.indexOf('\r\n'); end !== -1; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        queue = queue.then(() => handle(line)).catch(() => undefined);
      }
    };
    socket.on('data', onData);

    /**
     * AUTH TLS accepted: the connection speaks TLS from the next byte. The client sends nothing
     * before it reads the 234, so no byte of its handshake reached the plain listener.
     */
    function secureControl(secureContext: NonNullable<typeof context>): void {
      socket.removeListener('data', onData);
      const secure = new TLSSocket(socket, { isServer: true, secureContext });
      secure.setEncoding('utf8');
      secure.on('error', () => {
        // A handshake the client broke off (a certificate it refused): nothing to do here.
      });
      secure.on('data', onData);
      control = secure;
      controls.set(socket, secure);
      state.secure = true;
    }

    void reply('220 sealup test FTP server ready.');
  };

  const server = createServer(onControl);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as { port: number };

  return {
    loginFolder: tree.loginFolder,
    files: tree.files,
    folders: tree.folders,
    seedFile: tree.seedFile,
    seedLink: tree.seedLink,
    seedOther: tree.seedOther,
    seedFolder: tree.seedFolder,
    host,
    port,
    user,
    password,
    faults,
    commands: () => [...commands],
    logins: () => logins,
    openConnections: () => controls.size,
    dataAddresses: () => [...dataAddresses],
    dataTls: () => [...dataTls],
    closed: () =>
      controls.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idle.push(resolve);
          }),
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      dropAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The fault armed for the STOR numbered `n`, if any (consumed). */
function takeFault(
  armed: { at: number; code: TransportErrorCode }[],
  n: number,
): TransportErrorCode | undefined {
  const index = armed.findIndex((fault) => fault.at === n);
  if (index === -1) return undefined;
  return armed.splice(index, 1)[0]?.code;
}

/** The reply a Unix FTP server gives for each kind of failure (the system's words). */
function replyFor(code: TransportErrorCode): string {
  switch (code) {
    case 'not-found':
      return '553 Could not create file: No such file or directory.';
    case 'permission':
      return '550 Could not create file: Permission denied.';
    case 'quota':
      return '552 Could not create file: Disk quota exceeded.';
    default:
      return '451 Requested action aborted: local error in processing.';
  }
}
