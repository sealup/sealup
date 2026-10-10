// transport: talking to the server, over SFTP or FTP.
//
// Decision hidden: ssh2 in pure JavaScript (loaded on the first connect, not at start), TCP
// no-delay, host key pinning, password login, several SFTP channels on the one connection with up
// to `parallel` requests in flight across them, capability probe (posix-rename), the connect
// bound and per-request timeouts, and the mapping of every server error to a TransportError: a
// code, a reason and facts (never words: report words them).
//
// Interface: connect(target, { signal, handshakeTimeoutMs?, channels? }) returns a Session (the
// port in contracts); it is a Connect, and tests (and the channel measurement) may shorten the
// handshake bound or set the channel count. `defaultChannels` is the count a deploy asks for.
// scanHostKey(server, { signal, timeoutMs, type? }) is the host-key scan port (ScanHostKey): the
// key the server shows, its fingerprint and OpenSSH line, with no login (`sealup keyscan`, R7).
// connectFtp(target, { signal, handshakeTimeoutMs? }) is the FTP Connect (spec #41 decisions 3–7,
// ftp.ts): basic-ftp, loaded on the first connect; a pool of `parallel` connections (at most 16);
// SITE CHMOD and RNTO probed at connect (Capabilities); MLSD when FEAT offers MLST, else LIST;
// R17's put as STOR of an empty file, SITE CHMOD, then APPE; PASV's address ignored (R9). connect
// hands it every `ftp://` and `ftps://` target (plan 05 T03, T04); FTPS is explicit TLS before
// the user name, the certificate checked or pinned by `tlsFingerprint` (R8).
// scanCertificate(server, { signal, timeoutMs }) is the certificate scan port (ScanCertificate):
// the certificate an `ftps://` server shows and what the normal check says, with no login.
// packTar(root, entries) packs files into one gzip tar stream for the SSH archive (tar.ts; spec
// #41 decision 14): pack only, ustar plus PAX for long and non-ASCII names, no child process (R5).
//
// Invariants: the host key is checked before any credential is sent (R7): ssh2 sends the password
// only after the key exchange, and the key exchange stops when the key is not the pinned one. The
// pinned key's type is asked for first, so a server holding several keys shows the pinned one.
// The password is tried once, alone (no `none` probe, no keyboard-interactive): a refused login
// is never retried. The only module that calls reveal() on a secret. A scan takes no credential
// and ends the connection once the key exchange is done, before any authentication method.
//
// Channels (decision 0026, point 1, replacing ruling 1's "one channel"): one SSH connection per
// session, whatever the channel count. After login, the first channel resolves the login folder
// and probes posix-rename, then the others are opened at once: `min(channels, parallel)` in all,
// `channels` being `defaultChannels` unless connect is told otherwise (never the config). A
// channel the server refuses is not an error, nor is one it leaves unanswered for 2 s (dropped,
// and closed if it opens later): the session goes on with the channels it got, at least the
// first, and prints nothing. `parallel` still counts SFTP requests in flight across all files
// and all channels, not files: it is split evenly over the channels open. Each Session operation
// runs all its requests on one channel (a file handle belongs to its channel), the one with the
// fewest requests waiting and in flight. An upload's rename is an operation of its own and may
// use another channel: harmless, as the file is closed first. No ordering is assumed across
// channels (execute awaits what must come first).
//
// mkdir of an existing folder and remove of a missing file are done, not errors. Operations
// waiting or in flight fail with connection-lost when the connection drops, on every channel. A
// channel the server closes alone, even while the others are still opening, fails only its own;
// later operations use the others, and its share of `parallel` goes to them. A request with no
// answer within `timeout` fails with timeout and the session stays open. The whole connect (TCP
// to the first channel's login folder) has its own bound: `timeout`, never under 10 s; the extra
// channels wait within what is left of it, and never fail it. Ctrl-C (`signal`) stops a connect
// at once; once the session is open, the signal is execute's.
//
// Must never know: the plan, the manifest format, the config file, how output is printed.
//
// Status (tickets 05, 08; sealup/sealup#16): SFTP over ssh2; the signal and the connect bound;
// several channels, 2 by default (the OVH measurement, sealup/sealup#20, recorded in 0026). Plan
// 05 T02 (sealup/sealup#43): the FTP Session over basic-ftp, through the same contract suites.
// Plan 05 T13 (spec #41 decision 21): ssh2's keepalive (`keepalive`), so a half-dead link ends in
// about 30 s and deploy reconnects; a reconnect is a new connect, which checks the key again.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import type {
  Client,
  ConnectConfig,
  ParsedKey,
  PasswordAuthMethod,
  PublicKeyAuthMethod,
  ServerHostKeyAlgorithm,
  SFTPWrapper,
} from 'ssh2';
import {
  type HostKeyId,
  isFtp,
  type ScanHostKey,
  type ScannedHostKey,
  type Session,
  type Target,
  TransportError,
} from '../contracts/index.ts';
import { inCommandSet, parseServerPath } from '../paths/index.ts';
import { reveal } from '../secret/index.ts';
import { createArchive, probeTar } from './archive.ts';
import { connectFtp } from './ftp.ts';
import { type Channel, createSftpSession, watchChannel } from './session.ts';
import { handshakeBound, interrupted, unreachable } from './unreachable.ts';

export { tarCommand } from './archive.ts';
export { connectFtp, scanCertificate } from './ftp.ts';
export { packTar, type TarEntry } from './tar.ts';

/**
 * The SFTP channels a session asks for, `parallel` permitting. Measured on OVH Perso (#20,
 * spikes/06-channel-measure/), first deploy of 5,862 files, two runs each: 1×64 14.5 and 14.0 s,
 * 2×32 12.0 and 16.0 s, 4×16 13.0 and 12.7 s, 8×8 14.8 and 12.7 s. The rule: the fewest
 * channels within 10 % of the fastest run.
 */
export const defaultChannels = 2;

/** Connect's options: the Connect port's, plus the handshake bound and the channel count. */
interface ConnectOptions {
  readonly signal: AbortSignal | undefined;
  /**
   * How long the whole connect may take (TCP, key exchange, login, first SFTP channel; the extra
   * channels wait within what is left, extraChannelWaitMs at most). Default: the target's
   * `timeout`, never under 10 s. `timeout` bounds each SFTP request once logged in; a key
   * exchange is several round trips plus key maths, and on a slow link or a loaded runner it
   * takes longer than a short per-request timeout (ticket 08).
   */
  readonly handshakeTimeoutMs?: number;
  /**
   * How many SFTP channels to ask for; at most `parallel` are opened. Default `defaultChannels`.
   * For tests and the channel measurement only: not in the target, not in the config.
   */
  readonly channels?: number;
}

/**
 * How long the extra channels may take to open once the first one is up, within what is left of
 * the connect bound. An extra channel is three round trips (open, the SFTP subsystem, its version
 * answer), as the first one was; 2 s is room for that over a slow link or a loaded runner, and a
 * server that never answers costs a connect at most 2 s more. A healthy one never waits for it:
 * the wait ends once every channel has answered.
 */
const extraChannelWaitMs = 2_000;

/**
 * ssh2's keepalive (spec #41 decision 21): a request every 10 s with no answer, and the
 * connection is ended after 3 of them go unanswered.
 */
export const keepalive = { keepaliveInterval: 10_000, keepaliveCountMax: 3 } as const;

/**
 * Opens a logged-in Session to a target, or fails with a TransportError. ssh2 is loaded here, on
 * the first connect, not at start: `--version` and `--help` never pay for it (esbuild keeps a
 * bundled CommonJS module lazy behind a dynamic import).
 */
export const connect = async (
  target: Target,
  {
    signal,
    handshakeTimeoutMs = handshakeBound(target.timeoutMs),
    channels = defaultChannels,
  }: ConnectOptions,
): Promise<Session> => {
  // ftp:// and ftps://: the FTP pool (ftp.ts), `parallel` connections; no host key to pin (FTPS
  // checks the certificate instead).
  const { protocol } = target.server;
  if (isFtp(protocol)) {
    return connectFtp(target, { signal, handshakeTimeoutMs });
  }
  const { Client, utils } = (await import('ssh2')).default;
  return new Promise<Session>((resolve, reject) => {
    const pinned = target.hostKey;
    if (pinned === undefined) {
      // deploy stops before this (S16); never connect to a server sealup cannot identify.
      reject(new TransportError('host-key', 'no-host-key'));
      return;
    }
    if (signal?.aborted === true) {
      reject(interrupted());
      return;
    }
    // The key is read here, before anything is dialled: one sealup cannot read never reaches
    // the network (decision 0033).
    const login = loginMethod(target, utils.parseKey);
    if (login instanceof TransportError) {
      reject(login);
      return;
    }
    const expected = Buffer.from(pinned.key, 'base64');
    const deadline = Date.now() + handshakeTimeoutMs;
    let received: HostKeyId | undefined;
    let settled = false;
    const client = new Client();
    const settle = (): void => {
      settled = true;
      clearTimeout(bound);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: TransportError): void => {
      if (settled) return;
      settle();
      client.end();
      reject(error);
    };
    // Ctrl-C during the handshake or the login stops it at once: nothing was sent but the key
    // exchange and, at most, the password.
    function onAbort(): void {
      // Destroyed, not ended: a server that never answers would keep a half-closed socket (and
      // ssh2's handshake timer) alive, and the process with it.
      client.destroy();
      fail(interrupted());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    // One bound for the connect: TCP, key exchange, login, first SFTP channel, login folder.
    const bound = setTimeout(() => {
      client.destroy();
      fail(new TransportError('unreachable', 'no-answer', { timeoutMs: handshakeTimeoutMs }));
    }, handshakeTimeoutMs);

    client.on('error', (error) => fail(connectError(error, received)));
    client.on('close', () => {
      fail(new TransportError('unreachable', 'closed'));
    });
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (error) {
          fail(new TransportError('protocol', 'no-sftp', { cause: error }));
          return;
        }
        const first = watchChannel(sftp, target.timeoutMs);
        sftp.realpath('.', (realpathError, folder) => {
          const loginFolder = realpathError ? undefined : parseServerPath(folder);
          if (loginFolder === undefined || !loginFolder.ok) {
            fail(new TransportError('protocol', 'no-login-folder'));
            return;
          }
          const wanted = Math.max(1, Math.min(channels, target.parallel));
          // Logged in, with a channel: the connect can no longer fail for want of an answer. The
          // extra channels get their own wait, ending before the connect bound would have.
          clearTimeout(bound);
          const waitMs = Math.min(extraChannelWaitMs, Math.max(0, deadline - Date.now()));
          void openChannels(client, wanted - 1, waitMs, target.timeoutMs).then((others) => {
            if (settled) {
              for (const other of others) other.sftp.end();
              return;
            }
            // Once logged in, Ctrl-C is execute's (in-flight operations finish, ticket 08), and
            // each request has its own `timeout`.
            settle();
            const session = createSftpSession(client, [first, ...others], {
              loginFolder: loginFolder.path,
              caps: {
                replace: hasPosixRename(sftp) ? 'posix-rename' : 'unlink-then-rename',
                setMode: true,
              },
              parallel: target.parallel,
              timeoutMs: target.timeoutMs,
            });
            // ssh://: one probe for `tar`; without it (or with a login folder no command may
            // hold, R15) the session goes file by file, as on sftp:// (0034).
            if (target.server.protocol !== 'ssh' || !inCommandSet(loginFolder.path)) {
              resolve(session);
              return;
            }
            void probeTar(client, target.timeoutMs).then((has) => {
              resolve(
                has ? { ...session, archive: createArchive(client, target.timeoutMs) } : session,
              );
            });
          });
        });
      });
    });

    const config: ConnectConfig = {
      host: target.server.host,
      port: target.server.port,
      sock: dial(target.server, () => {
        client.destroy();
        fail(speaksFtp());
      }),
      username: target.server.user,
      // One method, tried once: no `none` probe, no agent, no keyboard-interactive, no retry.
      authHandler: [login],
      hostVerifier: (key: Buffer) => {
        if (key.equals(expected)) return true;
        received = describeKey(key);
        return false;
      },
      algorithms: { serverHostKey: hostKeyAlgorithms(pinned.type) },
      // ssh2's own bound, a little later than ours (ours words the error).
      readyTimeout: handshakeTimeoutMs + 1_000,
      // A half-dead link is noticed in about 30 s (spec #41 decision 21): its operations then
      // fail with connection-lost, and deploy reconnects.
      ...keepalive,
    };
    client.connect(config);
    client.setNoDelay(true);
  });
};

/**
 * The host-key scan (spec #24 decision 6, R7): the key the server shows, once it has proved it
 * holds it (ssh2 checks the exchange's signature before the handshake ends). The connection ends
 * right then, before the login service is asked for or any authentication method tried: there is
 * no credential to send, and the auth handler would refuse one anyway. Bounded like connect.
 */
export const scanHostKey: ScanHostKey = async (server, { signal, timeoutMs, type }) => {
  const { Client } = (await import('ssh2')).default;
  return new Promise<ScannedHostKey>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(interrupted());
      return;
    }
    const boundMs = handshakeBound(timeoutMs);
    let shown: Buffer | undefined;
    let settled = false;
    const client = new Client();
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(bound);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const fail = (error: TransportError): void => {
      if (!settle()) return;
      client.destroy();
      reject(error);
    };
    function onAbort(): void {
      fail(interrupted());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const bound = setTimeout(() => {
      fail(new TransportError('unreachable', 'no-answer', { timeoutMs: boundMs }));
    }, boundMs);

    client.on('error', (error) => fail(connectError(error, undefined)));
    client.on('close', () => fail(new TransportError('unreachable', 'closed')));
    // The key exchange is done and its signature checked: the server holds the key it showed.
    client.on('handshake', () => {
      if (shown === undefined || !settle()) return;
      client.destroy();
      const { type: shownType, fingerprint } = describeKey(shown);
      resolve({ type: shownType, fingerprint, line: `${shownType} ${shown.toString('base64')}` });
    });
    client.connect({
      host: server.host,
      port: server.port,
      sock: dial(server, () => fail(speaksFtp())),
      username: server.user,
      // Never reached (the handshake ends the scan), and refusing if it were: no method at all.
      authHandler: () => false,
      hostVerifier: (key: Buffer) => {
        shown = Buffer.from(key);
        return true;
      },
      algorithms: {
        serverHostKey: type === undefined ? [...allHostKeyAlgorithms] : hostKeyAlgorithms(type),
      },
      readyTimeout: boundMs + 1_000,
    });
    client.setNoDelay(true);
  });
};

/**
 * Opens `count` more SFTP channels at once, and resolves to those the server granted within
 * `waitMs`, each watched from the moment it opened. A refused one is left out (a server may cap
 * the channels of a connection), and so is one with no answer by then (closed if it opens
 * later); neither is an error.
 */
function openChannels(
  client: Client,
  count: number,
  waitMs: number,
  timeoutMs: number,
): Promise<Channel[]> {
  if (count === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const granted: Channel[] = [];
    let answered = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(wait);
      resolve(granted);
    };
    const wait = setTimeout(finish, waitMs);
    for (let i = 0; i < count; i++) {
      client.sftp((error, sftp: SFTPWrapper | undefined) => {
        if (done) {
          // Too late: the session went on without it.
          sftp?.on('error', () => {
            // Closed by us; nothing waits on it.
          });
          sftp?.end();
          return;
        }
        if (!error && sftp !== undefined) granted.push(watchChannel(sftp, timeoutMs));
        if (++answered === count) finish();
      });
    }
  });
}

/** ssh2's key reader: a parsed key, or an Error saying why it cannot read it. */
type ParseKey = (key: string, passphrase?: string) => ParsedKey | Error;

/**
 * The one way a target logs in (decision 0033): its password, or its private key read now, with
 * its passphrase. A key sealup cannot read is a TransportError of code `private-key`, from facts
 * only: ssh2's own error stays as the cause, for `--debug` (its words hold no key).
 */
function loginMethod(
  target: Target,
  parseKey: ParseKey,
): PasswordAuthMethod | PublicKeyAuthMethod | TransportError {
  const username = target.server.user;
  if (target.privateKey === undefined) {
    // config gives every target a password or a key; this can only fail on a bug.
    if (target.password === undefined) throw new RangeError('a target needs a password or a key');
    return { type: 'password', username, password: reveal(target.password) };
  }
  const text = reveal(target.privateKey);
  const passphrase = target.passphrase === undefined ? undefined : reveal(target.passphrase);
  const parsed = parseKey(text, passphrase);
  if (!(parsed instanceof Error)) {
    // A public key reads as a key, but cannot sign a login.
    if (parsed.isPrivateKey()) return { type: 'publickey', username, key: parsed };
    return new TransportError('private-key', 'key-unreadable');
  }
  const cause = { cause: parsed };
  // ssh2 says so when a key is encrypted and no passphrase was given: read again without one,
  // the same words tell an encrypted key from one it cannot read at all.
  const encrypted = (error: ParsedKey | Error): boolean =>
    error instanceof Error && /no passphrase given/i.test(error.message);
  if (passphrase === undefined) {
    return new TransportError(
      'private-key',
      encrypted(parsed) ? 'passphrase-missing' : 'key-unreadable',
      cause,
    );
  }
  return new TransportError(
    'private-key',
    encrypted(parseKey(text)) ? 'passphrase-wrong' : 'key-unreadable',
    cause,
  );
}

/**
 * The TCP connection ssh2 runs over, dialled here so its first bytes can be read (S19, spec #41
 * decision 9): an SSH server opens with `SSH-…`, an FTP server with its `220` greeting and then
 * waits for a command, which ssh2 would take for a banner and wait out until the connect bound.
 * The first chunk is looked at as the socket hands it to ssh2 (its `emit`), so the stream's
 * flow is left as ssh2 sets it; an FTP greeting is not passed on, and `onFtp` ends the connect.
 */
function dial(server: { readonly host: string; readonly port: number }, onFtp: () => void): Socket {
  const socket = new Socket();
  const emit = socket.emit.bind(socket);
  let first = true;
  socket.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'data' && first) {
      first = false;
      if (/^220[ -]/.test(String(args[0]))) {
        onFtp();
        return true;
      }
    }
    return emit(event, ...args);
  }) as typeof socket.emit;
  socket.connect({ host: server.host, port: server.port });
  return socket;
}

/** An SSH URL on a port that greeted as FTP does: nothing was sent (S19). */
function speaksFtp(): TransportError {
  return new TransportError('unreachable', 'speaks-ftp');
}

/**
 * A failure before login as a code (it decides the exit code, decision 0023) and a reason;
 * ssh2's own error stays as the cause, for `--debug`.
 */
function connectError(
  error: Error & { level?: string; code?: unknown },
  received: HostKeyId | undefined,
): TransportError {
  const cause = { cause: error };
  if (received !== undefined)
    return new TransportError('host-key', 'other-key', { received, ...cause });
  if (error.level === 'client-authentication') {
    return new TransportError('auth', 'login-refused', cause);
  }
  if (error.level === 'client-timeout')
    return new TransportError('unreachable', 'handshake', cause);
  if (error.level === 'client-socket' || error.level === 'client-dns') {
    return unreachable(error.code, error);
  }
  return new TransportError('protocol', 'not-ssh', cause);
}

/** The type written in a key blob (its first SSH string) and its OpenSSH fingerprint. */
function describeKey(key: Buffer): HostKeyId {
  const length = key.length >= 4 ? key.readUInt32BE(0) : 0;
  const type = key.subarray(4, 4 + length).toString('latin1');
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return { type, fingerprint: `SHA256:${digest}` };
}

/** ssh2's host key algorithms, the pinned key's own first. */
const allHostKeyAlgorithms: readonly ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
];

function hostKeyAlgorithms(type: string): ServerHostKeyAlgorithm[] {
  const own: readonly string[] =
    type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [type];
  const first = allHostKeyAlgorithms.filter((name) => own.includes(name));
  return [...first, ...allHostKeyAlgorithms.filter((name) => !own.includes(name))];
}

/**
 * Whether the server offered OpenSSH's posix-rename. ssh2 keeps the extensions the server
 * announced in a field it does not document; reading it sends nothing.
 */
function hasPosixRename(sftp: object): boolean {
  const extensions: unknown = (sftp as { _extensions?: unknown })._extensions;
  return (
    typeof extensions === 'object' &&
    extensions !== null &&
    (extensions as Record<string, unknown>)['posix-rename@openssh.com'] === '1'
  );
}
