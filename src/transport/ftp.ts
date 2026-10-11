// The FTP transport's connect (spec #41 decisions 3–7): a pool of logged-in connections over
// basic-ftp, and the Session over them (ftp-session.ts).
//
// Connect: the first connection logs in alone (a refused login is never sent twice: I-072), finds
// the login folder (PWD) and probes the server in it with a temp file: SITE CHMOD (R17's
// `setMode`) and whether RNTO replaces an existing file (`replace`). Meanwhile the other
// connections log in, `parallel` in all (at most 16); one the server refuses, or that has not
// logged in within a few seconds, is left out without an error, as SFTP's extra channels are.
//
// Data connections are passive. EPSV first; with PASV the address in the reply is ignored and the
// control's own host is used (R9): a server cannot send our files, or its data, elsewhere.
// basic-ftp refuses a command with CR, LF or NUL (R4; the session refuses such a path before) and
// a control reply over 64 kB (R21).
//
// FTPS (`ftps://`, R8, spec #41 decision 8) is explicit TLS: right after the greeting, before the
// user name, every connection sends AUTH TLS, checks the certificate, then PBSZ 0 and PROT P, so
// the data connections are TLS too and resume the control's session (basic-ftp hands them its
// session). The check: with `tlsFingerprint`, the certificate's SHA-256 must be the pinned one
// (the pin replaces the CA and name checks, so a shared host's certificate naming another host
// passes), on the control and on each data connection; without it, Node's CAs and the host name,
// as a browser checks them. A refusal or a failed check is a `tls` error before USER: never a
// fallback to plain FTP.
//
// basic-ftp is loaded on the first connect, as ssh2 is: `--version` never pays for it.

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import type { Client, FTPContext, FTPResponse } from 'basic-ftp';
import {
  type Capabilities,
  type CertificateScan,
  maxFtpConnections,
  type ScanCertificate,
  type ServerCertificate,
  type ServerPath,
  type Session,
  type Target,
  TransportError,
} from '../contracts/index.ts';
import { parseServerPath } from '../paths/index.ts';
import { reveal } from '../secret/index.ts';
import { createFtpSession, type FtpLink, refusedCertificate } from './ftp-session.ts';
import { handshakeBound, interrupted, unreachable } from './unreachable.ts';

/** How long the other connections may take to log in once the first is up. */
const extraConnectionWaitMs = 5_000;

type BasicFtp = typeof import('basic-ftp');
type Transfer = typeof import('basic-ftp/dist/transfer.js');
type Tls = typeof import('node:tls');

interface Library {
  readonly ftp: BasicFtp;
  readonly transfer: Transfer;
  readonly tls: Tls;
}

interface Dial {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** The per-command timeout once logged in. */
  readonly timeoutMs: number;
  /** FTPS: explicit TLS before the login, pinned to `pin` when the target has a tlsFingerprint. */
  readonly tls: { readonly pin: string | undefined } | undefined;
}

/** One connection, logged in, and what it found on the way. */
interface Opened {
  readonly link: FtpLink;
  readonly mlst: boolean;
  /** FTPS: the certificate it checked. */
  readonly certificate: ServerCertificate | undefined;
}

/** The first chunk was no FTP reply: something else listens on that port (an SSH server). */
class NotFtp extends Error {}

/** Connect's options: the Connect port's, plus the handshake bound. */
interface ConnectOptions {
  readonly signal: AbortSignal | undefined;
  /** How long the first connection may take to log in. Default: `timeout`, never under 10 s. */
  readonly handshakeTimeoutMs?: number;
}

/** Opens a logged-in FTP Session to a target, or fails with a TransportError. */
export const connectFtp = async (
  target: Target,
  { signal, handshakeTimeoutMs = handshakeBound(target.timeoutMs) }: ConnectOptions,
): Promise<Session> => {
  const library = await load();
  if (signal?.aborted === true) throw interrupted();
  // FTP logs in with a password only (decision 0033's key is SSH's); config is to refuse a key
  // on an FTP target, so this can only fail on a bug.
  if (target.password === undefined) throw new RangeError('an FTP target needs a password');
  const dial: Dial = {
    host: target.server.host,
    port: target.server.port,
    user: target.server.user,
    password: reveal(target.password),
    timeoutMs: target.timeoutMs,
    tls: target.server.protocol === 'ftps' ? { pin: target.tlsFingerprint } : undefined,
  };
  const deadline = Date.now() + handshakeTimeoutMs;
  const first = await openLink(library, dial, handshakeTimeoutMs, signal);
  const wanted = Math.max(1, Math.min(target.parallel, maxFtpConnections)) - 1;
  const waitMs = Math.min(extraConnectionWaitMs, Math.max(0, deadline - Date.now()));
  const others = openOthers(library, dial, wanted, waitMs);
  try {
    // The login folder and the probe are part of the connect: each command gets the connect's
    // bound, never less than `timeout`, so a short `timeout` over a slow link still connects.
    commandTimeout(first.link.client, Math.max(handshakeTimeoutMs, target.timeoutMs));
    const loginFolder = await loginFolderOf(first.link.client);
    const caps = await probe(first.link.client, loginFolder);
    commandTimeout(first.link.client, target.timeoutMs);
    const links = [first.link, ...(await others)];
    return createFtpSession(links, {
      loginFolder,
      caps: { ...caps, connections: links.length },
      mlst: first.mlst,
      replyError: library.ftp.FTPError,
      timeoutMs: target.timeoutMs,
      ...(first.certificate === undefined ? {} : { certificate: first.certificate }),
    });
  } catch (error) {
    first.link.client.close();
    for (const other of await others) other.client.close();
    throw error instanceof TransportError
      ? error
      : connectFailure(error, library, 'setup', 0, undefined);
  }
};

async function load(): Promise<Library> {
  const [ftp, transfer, tls] = await Promise.all([
    import('basic-ftp'),
    import('basic-ftp/dist/transfer.js'),
    import('node:tls'),
  ]);
  return { ftp: ftp.default, transfer: transfer.default, tls };
}

/**
 * One connection, logged in: greeting, login, FEAT, binary mode. Bounded by `boundMs` and the
 * signal; a failure is a TransportError, the connection closed.
 */
async function openLink(
  library: Library,
  dial: Dial,
  boundMs: number,
  signal: AbortSignal | undefined,
): Promise<Opened> {
  const client = new library.ftp.Client(boundMs, { allowSeparateTransferHost: false });
  const link: FtpLink = {
    client,
    ending: false,
    pasv: false,
    beforeStore: undefined,
    afterStore: undefined,
    pin: dial.tls?.pin,
  };
  client.prepareTransfer = (ftp) => passive(library.transfer, link, ftp);
  // The session's STOR turns: told once each STOR command is on the wire.
  const send = client.ftp.send.bind(client.ftp);
  client.ftp.send = (command: string): void => {
    send(command);
    if (command.startsWith('STOR ')) {
      const after = link.afterStore;
      link.afterStore = undefined;
      after?.();
    }
  };
  let step: Step = 'greeting';
  let certificate: ServerCertificate | undefined;
  const greeting = greet(client, dial.host, dial.port);
  const work = async (): Promise<Opened> => {
    await greeting;
    if (dial.tls !== undefined) {
      step = 'tls';
      certificate = await secure(library, client, dial.host, dial.tls.pin);
    }
    step = 'login';
    await client.sendIgnoringError('OPTS UTF8 ON');
    await client.login(dial.user, dial.password);
    step = 'setup';
    const features = await client.features();
    await client.send('TYPE I');
    const mlst = features.has('MLST');
    if (mlst) await client.sendIgnoringError('OPTS MLST type;size;modify;UNIX.mode;');
    // Logged in: each command now has the target's own timeout.
    commandTimeout(client, dial.timeoutMs);
    return { link, mlst, certificate };
  };
  return bounded(client, work, boundMs, signal, (error) =>
    connectFailure(error, library, step, boundMs, certificate),
  );
}

/** How long each later command of `client` may wait for its reply. */
function commandTimeout(client: Client, ms: number): void {
  (client.ftp as { timeout: number }).timeout = ms;
}

/** Dials and reads the greeting; a first chunk that is no FTP reply fails it (not-ftp). */
function greet(client: Client, host: string, port: number): Promise<unknown> {
  const greeting = client.connect(host, port);
  // Commands and replies are small and answered one by one: no Nagle delay on either.
  client.ftp.socket.setNoDelay(true);
  client.ftp.socket.once('data', (chunk: unknown) => {
    if (!/^\d{3}[ -]/.test(String(chunk))) client.ftp.closeWithError(new NotFtp());
  });
  return greeting;
}

/**
 * `work` on `client`, within `boundMs` and until Ctrl-C; on a failure the client is closed and
 * the error is `fail`'s.
 */
function bounded<T>(
  client: Client,
  work: () => Promise<T>,
  boundMs: number,
  signal: AbortSignal | undefined,
  fail: (error: unknown) => TransportError,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      signal?.removeEventListener('abort', onAbort);
      if (value !== undefined) {
        resolve(value);
        return;
      }
      client.close();
      reject(fail(error));
    };
    function onAbort(): void {
      finish(interrupted());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const bound = setTimeout(() => {
      finish(new TransportError('unreachable', 'no-answer', { timeoutMs: boundMs }));
    }, boundMs);
    work().then(
      (value) => finish(undefined, value),
      (error: unknown) => finish(error),
    );
  });
}

/**
 * The certificate an `ftps://` server shows after AUTH TLS, and what the normal check says of it
 * (`sealup keyscan`, spec #41 decision 12). The connection ends right after the TLS handshake:
 * no user name is sent.
 */
export const scanCertificate: ScanCertificate = async (server, { signal, timeoutMs }) => {
  const library = await load();
  if (signal?.aborted === true) throw interrupted();
  const client = new library.ftp.Client(timeoutMs, { allowSeparateTransferHost: false });
  let step: Step = 'greeting';
  const work = async (): Promise<CertificateScan> => {
    await greet(client, server.host, server.port);
    step = 'tls';
    const auth = await client.sendIgnoringError('AUTH TLS');
    if (auth.code !== 234) throw tlsRefused(auth);
    const options = { host: server.host, rejectUnauthorized: false };
    const socket = await upgrade(library, client.ftp.socket, options);
    client.ftp.socket = socket;
    const certificate = certificateOf(socket);
    if (socket.authorized) return { certificate, check: 'trusted' };
    return { certificate, check: otherName(socket) ? 'other-name' : 'untrusted' };
  };
  try {
    return await bounded(client, work, timeoutMs, signal, (error) =>
      connectFailure(error, library, step, timeoutMs, undefined),
    );
  } finally {
    client.close();
  }
};

/** Node's check refused the certificate for its name only (it is otherwise trusted). */
function otherName(socket: TLSSocket): boolean {
  return String(socket.authorizationError) === 'ERR_TLS_CERT_ALTNAME_INVALID';
}

type Step = 'greeting' | 'tls' | 'login' | 'setup';

/**
 * AUTH TLS on the control connection, the certificate checked (pinned, or by the CAs and the host
 * name), then PBSZ 0 and PROT P; before any user name. The data connections then use the same TLS
 * options: CA-checked ones reject a bad certificate themselves, pinned ones are checked in
 * `passive`. A refusal or a failed check is a `tls` TransportError.
 */
async function secure(
  library: Library,
  client: Client,
  host: string,
  pin: string | undefined,
): Promise<ServerCertificate> {
  const auth = await client.sendIgnoringError('AUTH TLS');
  if (auth.code !== 234) throw tlsRefused(auth);
  // Checked here, not by Node, so that a failure can tell which certificate the server showed.
  const socket = await upgrade(library, client.ftp.socket, { host, rejectUnauthorized: false });
  client.ftp.socket = socket;
  const certificate = certificateOf(socket);
  if (pin !== undefined) {
    if (certificate.sha256 !== pin) {
      throw new TransportError('tls', 'certificate-other', { certificate });
    }
  } else if (!socket.authorized) {
    throw new TransportError(
      'tls',
      otherName(socket) ? 'certificate-name' : 'certificate-untrusted',
      {
        certificate,
      },
    );
  }
  client.ftp.tlsOptions = { host, rejectUnauthorized: pin === undefined };
  for (const command of ['PBSZ 0', 'PROT P']) {
    const answer = await client.sendIgnoringError(command);
    if (answer.code < 200 || answer.code >= 300) throw tlsRefused(answer);
  }
  return certificate;
}

/** The control socket, upgraded to TLS once its handshake is done. */
function upgrade(
  library: Library,
  socket: FTPContext['socket'],
  options: ConnectionOptions,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    // Kept on a failed handshake, so a later error of the dead socket is never unhandled.
    const failed = (error: Error): void => {
      reject(new TransportError('tls', 'tls-refused', { cause: error }));
    };
    const secured = library.tls.connect({ ...options, socket }, () => {
      secured.removeListener('error', failed);
      resolve(secured);
    });
    secured.on('error', failed);
  });
}

function tlsRefused(answer: FTPResponse): TransportError {
  const said = answer.message.replace(/^\d{3}[ -]/, '').trim();
  return new TransportError('tls', 'tls-refused', said === '' ? {} : { serverSaid: said });
}

/** The certificate a TLS socket's server showed, as the output prints it. */
function certificateOf(socket: TLSSocket): ServerCertificate {
  const x509 = socket.getPeerX509Certificate();
  if (x509 === undefined) throw new TransportError('tls', 'certificate-untrusted');
  const parts = (text: string): string => text.split('\n').filter(Boolean).join(', ');
  return {
    subject: parts(x509.subject),
    issuer: parts(x509.issuer),
    validFrom: x509.validFromDate.toISOString(),
    validTo: x509.validToDate.toISOString(),
    sha256: x509.fingerprint256,
  };
}

/** The other connections: those logged in within `waitMs`; any later one is closed. */
async function openOthers(
  library: Library,
  dial: Dial,
  count: number,
  waitMs: number,
): Promise<FtpLink[]> {
  const opening = Array.from({ length: count }, () =>
    openLink(library, dial, Math.max(1, waitMs), undefined).then(
      ({ link }) => link,
      () => undefined,
    ),
  );
  const links = await Promise.all(opening);
  return links.filter((link): link is FtpLink => link !== undefined);
}

/** EPSV, else PASV with the reply's address ignored (R9); remembered per connection. */
async function passive(transfer: Transfer, link: FtpLink, ftp: FTPContext): Promise<FTPResponse> {
  let answer: FTPResponse | undefined;
  if (!link.pasv) {
    try {
      answer = await transfer.enterPassiveModeIPv6(ftp);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') {
        throw error;
      }
      link.pasv = true;
    }
  }
  if (answer === undefined) {
    answer = await ftp.request('PASV');
    const { port } = transfer.parsePasvResponse(answer.message);
    const host = ftp.socket.remoteAddress;
    if (host === undefined) throw new Error('control connection closed');
    await transfer.connectForPassiveTransfer(host, port, ftp);
  }
  const data = ftp.dataSocket;
  if (data !== undefined && 'getPeerX509Certificate' in data) guardData(link, data);
  await link.beforeStore?.();
  return answer;
}

/**
 * A TLS data connection, as real servers need it (ProFTPD, vsftpd; spec #41 decision 17):
 *
 * - It ends only once its handshake is done, and once what was written before is out. basic-ftp
 *   starts an upload as soon as the socket knows its cipher, which a TLS 1.3 client does from the
 *   server's hello: the end of an empty file then cut the handshake short, and the server refused
 *   the data connection (`decode error`). And under load, an end while an earlier write was still
 *   on its way sent the FIN before the client's last handshake record (ProFTPD logged an
 *   unexpected EOF, about one session in thirty): an empty write goes first, and its callback,
 *   which comes once what was queued before it is out, ends the connection. Writes wait for the
 *   handshake by themselves.
 * - An error before its handshake is done ends it alone, unless the certificate was refused.
 *   basic-ftp closes the control connection on any data error, but a server that refuses a
 *   command (STOR into a missing folder) closes the data connection it never accepted, often
 *   before its reply arrives: the reply, not a lost connection, then says what happened. No byte
 *   has moved yet, so nothing can be cut short.
 * - Pinned (`tlsFingerprint`): one that starts a new TLS session must show the pinned
 *   certificate, as the control did, checked when its handshake ends.
 */
function guardData(link: FtpLink, data: TLSSocket): void {
  let secure = false;
  data.once('secureConnect', () => {
    secure = true;
    // A resumed session shows no certificate (TLS 1.3), and needs none: only the server that
    // holds the control's session, whose certificate was checked, can resume it.
    if (link.pin === undefined || data.isSessionReused()) return;
    if (data.getPeerX509Certificate()?.fingerprint256 !== link.pin) {
      data.destroy(new TransportError('tls', 'certificate-other'));
    }
  });
  const end = data.end.bind(data) as (...args: unknown[]) => TLSSocket;
  const flushedEnd = (...args: unknown[]): void => {
    if (data.destroyed) end(...args);
    else data.write(Buffer.alloc(0), () => end(...args));
  };
  data.end = ((...args: unknown[]) => {
    if (data.destroyed) return end(...args);
    if (secure) flushedEnd(...args);
    else data.once('secureConnect', () => flushedEnd(...args));
    return data;
  }) as TLSSocket['end'];
  // basic-ftp closes the whole connection on the data socket's `error`, and on a `close` that
  // follows one: such an error is kept from its listeners, and that close told as a clean one.
  let contained = false;
  const emit = data.emit.bind(data) as (event: string | symbol, ...args: unknown[]) => boolean;
  data.emit = ((event: string | symbol, ...args: unknown[]) => {
    // A certificate refused stays a `tls` failure of the whole session (T04).
    if (event === 'error' && !secure && refusedCertificate(args[0]) === undefined) {
      contained = true;
      data.destroy();
      return true;
    }
    if (event === 'close' && contained) return emit('close', false);
    return emit(event, ...args);
  }) as TLSSocket['emit'];
}

/** The login folder: PWD, as an absolute ServerPath. */
async function loginFolderOf(client: Client): Promise<ServerPath> {
  let folder: string;
  try {
    folder = await client.pwd();
  } catch (error) {
    throw new TransportError('protocol', 'no-login-folder', { cause: error });
  }
  const parsed = parseServerPath(folder);
  if (!parsed.ok) throw new TransportError('protocol', 'no-login-folder');
  return parsed.path;
}

/**
 * What the server can do, found with a temp file in the login folder: SITE CHMOD (R17), and
 * whether RNTO replaces an existing file. When no temp file can be made there, the safe answers:
 * no mode, and rename by removing first.
 */
async function probe(client: Client, loginFolder: ServerPath): Promise<Capabilities> {
  const base = `${loginFolder === '/' ? '' : loginFolder}/.sealup-probe-${randomBytes(6).toString('hex')}`;
  const [a, b] = [base, `${base}-2`];
  const empty = (): Readable => Readable.from([], { objectMode: false });
  try {
    await client.uploadFrom(empty(), a);
  } catch (error) {
    if (isReply(error)) return { replace: 'unlink-then-rename', setMode: false };
    throw error;
  }
  try {
    const chmod = await client.sendIgnoringError(`SITE CHMOD 600 ${a}`);
    const setMode = chmod.code >= 200 && chmod.code < 300;
    await client.uploadFrom(empty(), b);
    const from = await client.sendIgnoringError(`RNFR ${a}`);
    const to = from.code === 350 ? await client.sendIgnoringError(`RNTO ${b}`) : from;
    const replaces = from.code === 350 && to.code >= 200 && to.code < 300;
    return { replace: replaces ? 'posix-rename' : 'unlink-then-rename', setMode };
  } finally {
    await client.sendIgnoringError(`DELE ${a}`);
    await client.sendIgnoringError(`DELE ${b}`);
  }
}

/** A reply error from basic-ftp (it carries the reply's numeric code). */
function isReply(error: unknown): error is Error & { code: number } {
  return error instanceof Error && 'code' in error && typeof error.code === 'number';
}

/** A failure before the session opened, as a code and a reason (the exit code follows). */
function connectFailure(
  error: unknown,
  library: Library,
  step: Step,
  boundMs: number,
  certificate: ServerCertificate | undefined,
): TransportError {
  if (error instanceof TransportError) return error;
  // After the TLS check: the certificate passed, for the target block (a refused login).
  const cause = { cause: error, ...(certificate === undefined ? {} : { certificate }) };
  if (error instanceof NotFtp) return new TransportError('protocol', 'not-ftp', cause);
  if (error instanceof library.ftp.FTPError) {
    if (step === 'login') return new TransportError('auth', 'login-refused', cause);
    if (step === 'tls') return new TransportError('tls', 'tls-refused', cause);
    if (step === 'greeting') return new TransportError('unreachable', 'closed', cause);
    return new TransportError('protocol', 'not-ftp', cause);
  }
  const message = error instanceof Error ? error.message : '';
  if (/^Timeout/.test(message)) {
    return new TransportError('unreachable', 'no-answer', { timeoutMs: boundMs, ...cause });
  }
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  // A data connection of the connect's probe that Node's check refused (a new TLS session).
  const refused = refusedCertificate(error);
  if (refused !== undefined) return refused;
  if (typeof code === 'string') return unreachable(code, error);
  if (/closed connection|FIN packet/i.test(message)) {
    return new TransportError('unreachable', 'closed', cause);
  }
  return new TransportError('unreachable', 'broken', cause);
}
