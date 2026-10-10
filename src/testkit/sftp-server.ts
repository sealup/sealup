// The in-process SFTP server: ssh2's server mode on 127.0.0.1, files kept in memory, so the real
// transport runs end to end on any OS without containers (spec #1, story 77). It answers like
// OpenSSH's sftp-server speaking SFTP v3 without extensions: RENAME onto an existing file fails,
// MKDIR of an existing folder fails, RMDIR of a non-empty folder fails (the transport copes).
// It takes several SFTP channels on one connection, each with its own handles, and counts them.
// Faults (story 79): a refused login, the nth upload failing with a given code, a dropped
// connection, slow answers, data answers held until a number of them are in flight (pipelining
// tests that do not depend on the clock); and for channels (spec sealup/sealup#15): channels
// refused beyond a number (a host's cap), channel opens never answered beyond a number, a channel
// closed as soon as it is open, and the channel of the nth upload closed by the server alone. A
// changed host key is a test pinning another key than `hostKeyLine`. It takes a password, or a
// public key from its `authorizedKeys` (decision 0033), checking the signature as OpenSSH does.

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import ssh2, { type ServerChannel } from 'ssh2';
import type { TransportErrorCode } from '../contracts/index.ts';
import type { ArchiveFaults } from './archive-contract.ts';
import type { SessionFaults } from './session-contract-kit.ts';
import { readTar } from './tar.ts';
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

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

interface SftpServerOptions {
  /** What the server reports for `.` at login; created empty. Default `/home/deploy`. */
  readonly loginFolder?: string;
  /** The key types the server holds, the first one shown as `hostKeyLine`. Default ed25519. */
  readonly keyTypes?: readonly ('ed25519' | 'rsa' | 'ecdsa')[];
  /** The one password it accepts, for user `deploy`. */
  readonly password?: string;
  /**
   * What its shell offers on an exec channel (0034, 0039): `tar` (default) answers the probe and
   * runs the archive's command; `no-tar` and `no-gzip` answer the probe with exit 1 and no
   * marker; `no-shell` refuses every exec channel, as an SFTP-only account does;
   * `sftp-server` takes any command and runs an SFTP server on it (OpenSSH's ForceCommand),
   * which exits 0 once stdin ends; `silent` takes it and never answers.
   */
  readonly shell?: 'tar' | 'no-tar' | 'no-gzip' | 'no-shell' | 'sftp-server' | 'silent';
  /**
   * The public keys (`<type> <base64>` lines) it accepts for user `deploy`, as an
   * authorized_keys file holds them (decision 0033). Default none.
   */
  readonly authorizedKeys?: readonly string[];
  /**
   * The server's own clock, ms since 1970, which dates what it writes (default `Date.now`): one
   * behind this machine's shows a client clock that runs ahead (spec #41 decision 26).
   */
  readonly now?: () => number;
}

/** The Session faults, plus those about channels, which only an SFTP server has. */
interface SftpFaults extends SessionFaults, ArchiveFaults {
  /** Every later connection may open `count` channels; the server refuses the others. */
  refuseChannelsBeyond(count: number): void;
  /** Every later connection may open `count` channels; the server never answers the others. */
  stallChannelsBeyond(count: number): void;
  /** On every later connection, the server closes the `nth` channel (1 = the first) once open. */
  closeChannelOnOpen(nth: number): void;
  /**
   * The `nth` upload from now (1 = the next one) gets no answer: the server closes the channel
   * that carried it, and only that channel (its other requests go unanswered too).
   */
  closeChannelOnWrite(nth: number): void;
  /**
   * Holds the answers to the next WRITE and READ requests until `count` of them are held at
   * once, then until no request has come for 100 ms, then answers them all, and every later one
   * at once. So a client that pipelines `count` requests shows exactly `count` in mostInFlight
   * however slow the machine is (it cannot send more before an answer), and one that sends more
   * shows more. Should `count` never be reached, the held answers go out once no request has come
   * for 2 s: a client that pipelines less shows less rather than hanging.
   */
  holdData(count: number): void;
  /**
   * The next mkdir of `path` that fails (something is there) is answered only once `meanwhile`
   * has settled: what other clients do then lands between the failure and this client's next
   * request (a lock released, then made again by another run).
   */
  afterFailedMkdir(path: string, meanwhile: () => Promise<void>): void;
}

/** One authentication attempt the server saw: the method only, never what was sent. */
interface LoginAttempt {
  readonly method: string;
  readonly accepted: boolean;
}

export interface SftpServer extends TreeView {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** The server's (first) public key, as an OpenSSH line: what a config pins as `hostKey`. */
  readonly hostKeyLine: string;
  /** Its OpenSSH fingerprint, `SHA256:…`. */
  readonly fingerprint: string;
  readonly faults: SftpFaults;
  /** Every authentication attempt, in order (R7: none when the host key did not match). */
  logins(): readonly LoginAttempt[];
  /**
   * The most requests the server held unanswered at once while slow (fault `slow`): the
   * requests the client had in flight.
   */
  mostInFlight(): number;
  /** The READDIR requests the server answered, each with up to 100 names (R21's limit test). */
  readdirs(): number;
  /** The SFTP channels each logged-in connection opened, one number per connection, in order. */
  channels(): readonly number[];
  /** The names in each archive the server read whole, in order (0034). */
  archives(): readonly (readonly string[])[];
  /** Every command an exec channel asked for, in order, as the server received it (R15). */
  commands(): readonly string[];
  /** The exec channels open now: a probe or an archive the client has not closed. */
  execsOpen(): number;
  /** Resolves once no connection is open: every attempt a client made has been seen. */
  closed(): Promise<void>;
  stop(): Promise<void>;
}

/** What one open handle points at. */
type Handle =
  | {
      readonly kind: 'file';
      readonly path: string;
      /** Fault dropDuringRead: the connection drops at this handle's second READ. */
      readonly drop: boolean;
      /** The READs answered so far. */
      reads: number;
    }
  /** A folder being read: the names left to send, taken when it was opened. */
  | { readonly kind: 'folder'; readonly path: string; readonly left: [string, Entry][] };

/** Names sent per READDIR answer: a folder of more takes several requests, as on OpenSSH. */
const namesPerReaddir = 100;

/** The archive's probe, as the client sends it (0039): a marker only with tar and gzip. */
const archiveProbe =
  'command -v tar >/dev/null && command -v gzip >/dev/null && echo sealup-archive-ok';

export async function createSftpServer(options: SftpServerOptions = {}): Promise<SftpServer> {
  const tree = createTree(options.loginFolder ?? '/home/deploy');
  const { entries } = tree;
  const clock = options.now ?? Date.now;
  /** Now on the server's clock, whole seconds: the date of what it writes. */
  const stamp = (): number => Math.floor(clock() / 1000);
  const user = 'deploy';
  const password = options.password ?? 'sftp-test-password';
  const keys = (options.keyTypes ?? ['ed25519']).map(generateKey);
  const authorized = (options.authorizedKeys ?? []).map((line) => {
    const parsed = utils.parseKey(line);
    if (parsed instanceof Error || Array.isArray(parsed)) {
      throw new RangeError('authorizedKeys takes public key lines');
    }
    return parsed;
  });
  const [first] = keys;
  if (first === undefined) throw new RangeError('the server needs at least one key type');
  const hostKeyLine = first.public.split(' ').slice(0, 2).join(' ');

  const logins: LoginAttempt[] = [];
  let loginRefused = false;
  let slowMs = 0;
  let opens = 0;
  const armed: { at: number; code: TransportErrorCode }[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const connections = new Set<{ end(): unknown }>();
  /** Waiting for every connection to close (closed()). */
  const idle: (() => void)[] = [];
  let mostInFlight = 0;
  let readdirs = 0;
  const channels: number[] = [];
  let channelCap = Number.POSITIVE_INFINITY;
  let channelStall = Number.POSITIVE_INFINITY;
  let closeOnOpen = 0;
  const closings: number[] = [];
  let readOpens = 0;
  const drops: number[] = [];
  const changes = new Map<string, Uint8Array>();
  /** Fault afterFailedMkdir: what happens before the answer to a failed mkdir of a path. */
  const meanwhiles = new Map<string, () => Promise<void>>();
  const commands: string[] = [];
  let execsOpen = 0;
  const archives: string[][] = [];
  const shell = (options.shell ?? 'tar') !== 'no-shell';
  let archiveFault: 'drop' | 'fail' | 'stall' | undefined;

  /**
   * An exec channel, as a POSIX shell with GNU tar would answer it: the probe, then the archive's
   * one command, whose stdin (the whole archive) is read with testkit's tar reader and extracted
   * under the root, folders made, files replaced, modes less the umask, each dated now by the
   * server's clock (`-m`: the archive's dates are not kept). Any other command is not
   * found (exit 127). `drop` ends the connection (fault dropArchive).
   */
  const runCommand = (stream: ServerChannel, command: string, drop: () => void): void => {
    const ignore = (): void => {
      // A client that closed the channel first: nothing more to tell it.
    };
    stream.on('error', ignore);
    stream.stderr.on('error', ignore);
    const exit = (code: number, stderr = ''): void => {
      // The client closed the channel (Ctrl-C, its own failure): no one hears the answer.
      if (stream.destroyed || stream.writableEnded) return;
      if (stderr !== '') stream.stderr.write(stderr);
      stream.exit(code);
      stream.end();
      // Whatever stdin still brings is dropped, so the channel closes once the client is done.
      stream.resume();
    };
    if (options.shell === 'sftp-server') {
      // ForceCommand sftp-server: whatever the command, an SFTP server reads stdin, says
      // nothing to bytes that are no SFTP packet, and exits 0 once stdin ends.
      stream.on('end', () => exit(0));
      stream.resume();
      return;
    }
    if (options.shell === 'silent') {
      // Takes the channel and every byte, and never answers, not even once stdin ends.
      stream.resume();
      return;
    }
    const hasTar = options.shell !== 'no-tar';
    const hasGzip = hasTar && options.shell !== 'no-gzip';
    if (command === archiveProbe) {
      if (hasGzip) stream.write('sealup-archive-ok\n');
      exit(hasGzip ? 0 : 1);
      return;
    }
    const root = /^tar -xmzf - -C '([^']*)'$/.exec(command)?.[1];
    if (root === undefined || !hasTar) {
      exit(127, `sh: 1: ${command.split(' ')[0] ?? ''}: not found\n`);
      return;
    }
    if (!hasGzip) {
      stream.resume();
      exit(2, 'tar: gzip: Cannot exec: No such file or directory\n');
      return;
    }
    const fault = archiveFault;
    archiveFault = undefined;
    if (fault === 'stall') {
      // Never read: the client's window fills and its stream stalls.
      stream.pause();
      return;
    }
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (fault === 'drop') drop();
    });
    stream.on('end', () => {
      let files: ReturnType<typeof readTar>;
      try {
        files = readTar(Buffer.concat(chunks));
        archives.push(files.map((file) => file.name));
      } catch {
        return exit(2, 'gzip: stdin: unexpected end of file\ntar: Child returned status 1\n');
      }
      if (entries.get(root)?.kind !== 'folder') {
        return exit(2, `tar: ${root}: Cannot open: No such file or directory\n`);
      }
      for (const [index, file] of files.entries()) {
        const path = `${root === '/' ? '' : root}/${file.name}`;
        for (let folder = parentOf(path); folder !== root; folder = parentOf(folder)) {
          if (!entries.has(folder)) entries.set(folder, newFolder());
        }
        if (entries.get(path)?.kind === 'folder') {
          return exit(2, `tar: ${file.name}: Cannot open: Is a directory\n`);
        }
        // Fault failArchive: the disk fills during the last file, which keeps half its bytes.
        const last = fault === 'fail' && index === files.length - 1;
        const bytes = last ? file.bytes.subarray(0, file.bytes.length >> 1) : file.bytes;
        const written = writtenFile(undefined, bytes, stamp());
        entries.set(path, { ...written, mode: file.mode & ~umask });
      }
      // Fault failArchive: the disk filled during the last file (GNU tar goes on after an error,
      // then exits 2): every other file is there whole, and tar says it failed.
      if (fault === 'fail') {
        return exit(
          2,
          'tar: page.html: Cannot write: Disk quota exceeded\ntar: Exiting with failure status due to previous errors\n',
        );
      }
      exit(0);
    });
  };

  /** Answers now, or `slowMs` later (fault `slow`). */
  const later = (answer: () => void): void => {
    if (slowMs === 0) {
      answer();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      answer();
    }, slowMs);
    timers.add(timer);
    mostInFlight = Math.max(mostInFlight, timers.size);
  };

  /** Fault holdData: the answers held, and how many to hold before the quiet period starts. */
  let holdCount = 0;
  const held: (() => void)[] = [];
  let holdTimer: NodeJS.Timeout | undefined;
  const releaseHeld = (): void => {
    holdCount = 0;
    holdTimer = undefined;
    for (const answer of held.splice(0)) answer();
  };
  /** A WRITE's or READ's answer: held (fault holdData), else as any other. */
  const laterData = (answer: () => void): void => {
    if (holdCount === 0) {
      later(answer);
      return;
    }
    held.push(answer);
    mostInFlight = Math.max(mostInFlight, held.length);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(releaseHeld, held.length >= holdCount ? 100 : 2_000);
  };

  const faults: SftpFaults = {
    dropArchive() {
      archiveFault = 'drop';
    },
    failArchive() {
      archiveFault = 'fail';
    },
    stallArchive() {
      archiveFault = 'stall';
    },
    refuseChannelsBeyond(count) {
      if (!Number.isInteger(count) || count < 1) throw new RangeError('at least one channel');
      channelCap = count;
    },
    stallChannelsBeyond(count) {
      if (!Number.isInteger(count) || count < 1) throw new RangeError('at least one channel');
      channelStall = count;
    },
    closeChannelOnOpen(nth) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      closeOnOpen = nth;
    },
    dropDuringRead(nth) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      drops.push(readOpens + nth);
    },
    changeDuringRead(path, bytes) {
      changes.set(path, Uint8Array.from(bytes));
    },
    closeChannelOnWrite(nth) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      closings.push(opens + nth);
    },
    failWrite(nth, code) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      armed.push({ at: opens + nth, code });
    },
    refuseLogin() {
      loginRefused = true;
    },
    slow(ms) {
      slowMs = ms;
    },
    holdData(count) {
      if (!Number.isInteger(count) || count < 1) throw new RangeError('hold at least one answer');
      holdCount = count;
    },
    afterFailedMkdir(path, meanwhile) {
      meanwhiles.set(path, meanwhile);
    },
  };

  const server = new Server({ hostKeys: keys.map((key) => key.private) }, (client) => {
    connections.add(client);
    client.on('close', () => {
      connections.delete(client);
      if (connections.size === 0) for (const resolve of idle.splice(0)) resolve();
    });
    client.on('error', () => {
      // A client that drops or is dropped: nothing to do on the server side.
    });
    client.on('authentication', (ctx) => {
      let accepted = false;
      if (ctx.method === 'password') {
        accepted = !loginRefused && ctx.username === user && ctx.password === password;
      } else if (ctx.method === 'publickey') {
        // As OpenSSH: a key in authorized_keys is accepted, first as a query (no signature),
        // then signed; the signature is checked against that key.
        const known = authorized.find((key) => key.getPublicSSH().equals(ctx.key.data));
        accepted =
          !loginRefused &&
          ctx.username === user &&
          known !== undefined &&
          (ctx.signature === undefined ||
            (ctx.blob !== undefined && known.verify(ctx.blob, ctx.signature, ctx.hashAlgo)));
      }
      logins.push({ method: ctx.method, accepted });
      if (accepted) ctx.accept();
      else ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      const connection = channels.push(0) - 1;
      const cap = channelCap;
      const stall = channelStall;
      const shut = closeOnOpen;
      let asked = 0;
      let sessions = 0;
      client.on('session', (acceptSession, rejectSession) => {
        // A host that never answers a channel open: neither accepted nor refused.
        if (++asked > stall) return;
        // A host's cap on the channels of one connection (OpenSSH: MaxSessions).
        if (sessions >= cap) return rejectSession();
        const number = ++sessions;
        const session = acceptSession();
        session.on('exec', (acceptExec, rejectExec, info) => {
          commands.push(info.command);
          if (!shell) return rejectExec();
          const exec = acceptExec();
          execsOpen++;
          exec.once('close', () => execsOpen--);
          runCommand(exec, info.command, () => client.end());
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          channels[connection] = (channels[connection] ?? 0) + 1;
          // Closed once the SFTP version is sent: the client holds an open channel, then loses it.
          if (number === shut) sftp.once('ready', () => sftp.end());
          const handles = new Map<number, Handle>();
          let nextHandle = 0;
          const newHandle = (handle: Handle): Buffer => {
            const id = Buffer.alloc(4);
            id.writeUInt32BE(nextHandle);
            handles.set(nextHandle++, handle);
            return id;
          };
          const handleOf = (id: Buffer): Handle | undefined =>
            id.length === 4 ? handles.get(id.readUInt32BE(0)) : undefined;
          const status = (id: number, code: number, message?: string): void =>
            later(() => sftp.status(id, code, message));
          const fileAt = (path: string): Uint8Array | undefined => {
            const entry = entries.get(path);
            return entry?.kind === 'file' ? entry.bytes : undefined;
          };
          const parentIsFolder = (path: string): boolean =>
            entries.get(parentOf(path))?.kind === 'folder';

          sftp
            .on('REALPATH', (id, path) => {
              const resolved = path === '.' || path === '' ? tree.loginFolder : path;
              later(() =>
                sftp.name(id, [{ filename: resolved, longname: resolved, attrs: noAttrs }]),
              );
            })
            .on('OPEN', (id, path, flags, attrs) => {
              const entry = entries.get(path);
              if ((flags & OPEN_MODE.WRITE) !== 0) {
                opens++;
                const closing = closings.indexOf(opens);
                if (closing !== -1) {
                  closings.splice(closing, 1);
                  return sftp.end();
                }
                const fault = takeFault(armed, opens);
                if (fault === 'connection-lost') return client.end();
                if (fault === 'timeout') return; // never answered
                if (fault !== undefined) return status(id, ...statusFor(fault));
                if (!parentIsFolder(path)) return status(id, STATUS_CODE.NO_SUCH_FILE);
                if (entry?.kind === 'folder') return status(id, STATUS_CODE.FAILURE);
                if (entry === undefined) {
                  // Created with the mode asked for, less the umask (022), as open(2) does.
                  const file = writtenFile(undefined, new Uint8Array(), stamp());
                  const asked = attrs.mode === undefined ? file.mode : attrs.mode & 0o7777;
                  entries.set(path, { ...file, mode: asked & ~umask });
                } else if ((flags & OPEN_MODE.TRUNC) !== 0) {
                  entries.set(path, writtenFile(entry, new Uint8Array(), stamp()));
                }
              } else if (entry === undefined) {
                return status(id, STATUS_CODE.NO_SUCH_FILE);
              } else if (entry.kind === 'folder') {
                return status(id, STATUS_CODE.FAILURE);
              }
              let drop = false;
              if ((flags & OPEN_MODE.WRITE) === 0) {
                const index = drops.indexOf(++readOpens);
                if (index !== -1) drops.splice(index, 1);
                drop = index !== -1;
              }
              const handle = newHandle({ kind: 'file', path, drop, reads: 0 });
              later(() => sftp.handle(id, handle));
            })
            .on('WRITE', (id, handleId, offset, data) => {
              const handle = handleOf(handleId);
              const bytes = handle === undefined ? undefined : fileAt(handle.path);
              if (handle === undefined || bytes === undefined) {
                return status(id, STATUS_CODE.FAILURE);
              }
              const out = new Uint8Array(Math.max(bytes.length, offset + data.length));
              out.set(bytes);
              out.set(data, offset);
              const before = entries.get(handle.path);
              const firstByteMode =
                before?.kind === 'file' && before.bytes.length > 0
                  ? before.firstByteMode
                  : before?.mode;
              const written = writtenFile(before, out, stamp());
              entries.set(
                handle.path,
                firstByteMode === undefined ? written : { ...written, firstByteMode },
              );
              laterData(() => sftp.status(id, STATUS_CODE.OK));
            })
            .on('FSETSTAT', (id, handleId, attrs) => {
              const handle = handleOf(handleId);
              const entry = handle === undefined ? undefined : entries.get(handle.path);
              if (handle === undefined || entry === undefined) {
                return status(id, STATUS_CODE.FAILURE);
              }
              // Only the permission bits: sealup sets nothing else (R17).
              if (attrs.mode !== undefined) {
                entries.set(handle.path, { ...entry, mode: attrs.mode & 0o7777 });
              }
              status(id, STATUS_CODE.OK);
            })
            .on('READ', (id, handleId, offset, length) => {
              const handle = handleOf(handleId);
              if (handle?.kind !== 'file') return status(id, STATUS_CODE.FAILURE);
              // Fault dropDuringRead: one chunk arrived, then the connection drops.
              if (handle.drop && handle.reads > 0) return client.end();
              handle.reads++;
              // Fault changeDuringRead: the size was looked at (FSTAT); now the file changes.
              const change = changes.get(handle.path);
              const entry = entries.get(handle.path);
              if (change !== undefined && entry?.kind === 'file') {
                changes.delete(handle.path);
                entries.set(handle.path, { ...entry, bytes: change });
              }
              const bytes = fileAt(handle.path);
              if (bytes === undefined) return status(id, STATUS_CODE.FAILURE);
              if (offset >= bytes.length) {
                return laterData(() => sftp.status(id, STATUS_CODE.EOF));
              }
              const chunk = Buffer.from(bytes.subarray(offset, offset + length));
              laterData(() => sftp.data(id, chunk));
            })
            .on('FSTAT', (id, handleId) => {
              const handle = handleOf(handleId);
              const entry = handle === undefined ? undefined : entries.get(handle.path);
              if (entry === undefined) return status(id, STATUS_CODE.FAILURE);
              later(() => sftp.attrs(id, attrsOf(entry)));
            })
            .on('CLOSE', (id, handleId) => {
              if (handleOf(handleId) === undefined) return status(id, STATUS_CODE.FAILURE);
              handles.delete(handleId.readUInt32BE(0));
              status(id, STATUS_CODE.OK);
            })
            .on('STAT', (id, path) => {
              const entry = entries.get(path);
              // A link is followed (one step is enough here); a dangling one is no file.
              const target = entry?.kind === 'link' ? entries.get(entry.target) : entry;
              if (target === undefined) status(id, STATUS_CODE.NO_SUCH_FILE);
              else later(() => sftp.attrs(id, attrsOf(target)));
            })
            .on('LSTAT', (id, path) => {
              const entry = entries.get(path);
              if (entry === undefined) status(id, STATUS_CODE.NO_SUCH_FILE);
              else later(() => sftp.attrs(id, attrsOf(entry)));
            })
            .on('OPENDIR', (id, path) => {
              const entry = entries.get(path);
              // OpenSSH answers ENOTDIR as no such file, like a missing folder.
              if (entry?.kind !== 'folder') return status(id, STATUS_CODE.NO_SUCH_FILE);
              const left = childrenOf(entries, path);
              const handle = newHandle({ kind: 'folder', path, left });
              later(() => sftp.handle(id, handle));
            })
            .on('READDIR', (id, handleId) => {
              const handle = handleOf(handleId);
              if (handle?.kind !== 'folder') return status(id, STATUS_CODE.FAILURE);
              readdirs++;
              if (handle.left.length === 0) return status(id, STATUS_CODE.EOF);
              const names = handle.left.splice(0, namesPerReaddir).map(([filename, entry]) => ({
                filename,
                longname: filename,
                attrs: attrsOf(entry),
              }));
              later(() => sftp.name(id, names));
            })
            .on('RENAME', (id, from, to) => {
              const entry = entries.get(from);
              if (entry === undefined || !parentIsFolder(to)) {
                return status(id, STATUS_CODE.NO_SUCH_FILE);
              }
              // SFTP v3 without posix-rename: an existing target is a failure, as on OpenSSH.
              if (entries.has(to) || entry.kind !== 'file') return status(id, STATUS_CODE.FAILURE);
              entries.delete(from);
              entries.set(to, entry);
              status(id, STATUS_CODE.OK);
            })
            .on('REMOVE', (id, path) => {
              const entry = entries.get(path);
              if (entry === undefined) return status(id, STATUS_CODE.NO_SUCH_FILE);
              // unlink(2), as OpenSSH: a link goes itself, never what it points to.
              if (entry.kind !== 'file' && entry.kind !== 'link') {
                return status(id, STATUS_CODE.FAILURE);
              }
              entries.delete(path);
              status(id, STATUS_CODE.OK);
            })
            .on('MKDIR', (id, path) => {
              if (!parentIsFolder(path)) return status(id, STATUS_CODE.NO_SUCH_FILE);
              if (entries.has(path)) {
                const meanwhile = meanwhiles.get(path);
                if (meanwhile === undefined) return status(id, STATUS_CODE.FAILURE);
                meanwhiles.delete(path);
                void meanwhile().finally(() => status(id, STATUS_CODE.FAILURE));
                return;
              }
              entries.set(path, newFolder());
              status(id, STATUS_CODE.OK);
            })
            .on('RMDIR', (id, path) => {
              const entry = entries.get(path);
              if (entry === undefined) return status(id, STATUS_CODE.NO_SUCH_FILE);
              if (entry.kind !== 'folder' || hasChildren(entries, path)) {
                return status(id, STATUS_CODE.FAILURE);
              }
              entries.delete(path);
              status(id, STATUS_CODE.OK);
            });
          for (const event of ['SETSTAT', 'READLINK', 'SYMLINK', 'EXTENDED']) {
            sftp.on(event, (id: number) => status(id, STATUS_CODE.OP_UNSUPPORTED));
          }
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    loginFolder: tree.loginFolder,
    files: tree.files,
    folders: tree.folders,
    seedFile: tree.seedFile,
    seedLink: tree.seedLink,
    seedOther: tree.seedOther,
    seedFolder: tree.seedFolder,
    host: '127.0.0.1',
    port,
    user,
    password,
    hostKeyLine,
    fingerprint: fingerprintOf(hostKeyLine),
    faults,
    logins: () => [...logins],
    mostInFlight: () => mostInFlight,
    readdirs: () => readdirs,
    channels: () => [...channels],
    commands: () => [...commands],
    execsOpen: () => execsOpen,
    archives: () => archives.map((names) => [...names]),
    closed: () =>
      connections.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idle.push(resolve);
          }),
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      clearTimeout(holdTimer);
      for (const connection of connections) connection.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A fresh host key pair. ssh2 1.17 writes an ed25519 key it cannot read back about once in 250
 * (measured 8 in 2,000), so a key is kept only once ssh2 parses it.
 */
function generateKey(type: 'ed25519' | 'rsa' | 'ecdsa'): { private: string; public: string } {
  for (;;) {
    const pair =
      type === 'rsa'
        ? utils.generateKeyPairSync('rsa', { bits: 2048 })
        : type === 'ecdsa'
          ? utils.generateKeyPairSync('ecdsa', { bits: 256 })
          : utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
}

const noAttrs = { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };

/** The server process's umask, as OpenSSH's sftp-server usually runs with. */
const umask = 0o022;

/** The kind bits of a mode (S_IFMT), as lstat gives them. */
const kindBits = { folder: 0o040000, file: 0o100000, link: 0o120000, other: 0o140000 } as const;

/** An entry's attributes, as lstat gives them (a link's size is its target's length). */
function attrsOf(entry: Entry) {
  const size =
    entry.kind === 'file' ? entry.bytes.length : entry.kind === 'link' ? entry.target.length : 0;
  return {
    ...noAttrs,
    mode: kindBits[entry.kind] | entry.mode,
    size,
    atime: entry.mtime,
    mtime: entry.mtime,
  };
}

/** The fault armed for the upload numbered `n`, if any (consumed). */
function takeFault(
  armed: { at: number; code: TransportErrorCode }[],
  n: number,
): TransportErrorCode | undefined {
  const index = armed.findIndex((fault) => fault.at === n);
  if (index === -1) return undefined;
  return armed.splice(index, 1)[0]?.code;
}

/** The SFTP v3 answer a real server gives for each kind of failure. */
function statusFor(code: TransportErrorCode): [number, string] {
  switch (code) {
    case 'not-found':
      return [STATUS_CODE.NO_SUCH_FILE, 'No such file'];
    case 'permission':
      return [STATUS_CODE.PERMISSION_DENIED, 'Permission denied'];
    case 'quota':
      // SFTP v3 has no quota code: servers send a failure with the system's message.
      return [STATUS_CODE.FAILURE, 'Disk quota exceeded'];
    case 'protocol':
      return [STATUS_CODE.BAD_MESSAGE, 'Bad message'];
    default:
      return [STATUS_CODE.FAILURE, 'Failure'];
  }
}

function fingerprintOf(line: string): string {
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}
