// contracts, the Session port and transport errors: what a transport (and the memory fake)
// offers once logged in, how a connection is opened, and the facts of a server problem.
// Additions here: a Session operation, a Capabilities field, a TransportReason, a transport port
// (the host-key scan, the SSH archive).

import type { RemotePath, Secret, ServerPath } from './brands.ts';
import type { ServerUrl, Target } from './config.ts';

// ---------------------------------------------------------------------------------------------
// The Session port: one logged-in connection to the server (decision 0013: every transport and
// the memory fake pass the one contract suite in testkit, which is the executable form of the
// rules written here).
// ---------------------------------------------------------------------------------------------

/** What a server can do, found out at connect. */
export interface Capabilities {
  /**
   * How rename() replaces an existing file: `posix-rename` in one atomic step (the OpenSSH
   * extension), `unlink-then-rename` with a short gap where the file is missing. Either way
   * rename() replaces; the caller does not do the fallback itself.
   */
  readonly replace: 'posix-rename' | 'unlink-then-rename';
  /**
   * Whether put() can give a file the mode asked for (R17). SFTP always can (on the open handle).
   * FTP can when the server accepts `SITE CHMOD`, probed at connect on a temp file; a server that
   * refuses it fails every put with a mode (`mode-refused`), before any content is sent.
   */
  readonly setMode: boolean;
  /**
   * FTP (spec #41 decision 4, story 16): the connections the pool opened, at most `parallel`; a
   * server that turns some away gives fewer. Absent on the other protocols.
   */
  readonly connections?: number;
}

/**
 * The bytes to upload: a local file (read by the transport, streamed), bytes in memory, or the
 * value of a Secret, UTF-8 (a file written from a secret, R17): only the transport reveals it,
 * in memory, so it never touches the local disk.
 */
export type Source =
  | { readonly file: string }
  | { readonly bytes: Uint8Array }
  | { readonly secret: Secret };

/** How put() writes a file. */
export interface PutOptions {
  /** Permission bits (`0o600`), set before the first byte (R17). */
  readonly mode?: number;
}

export type ReadResult =
  /**
   * `mode`: the file's permission bits as the server gives them, with setuid, setgid and sticky
   * (as ServerEntry's): a file written from a secret is the same only with its mode too (R17).
   */
  | { readonly kind: 'found'; readonly bytes: Uint8Array; readonly mode: number }
  | { readonly kind: 'not-found' }
  /** Larger than the limit the caller gave; nothing more is read (R21). */
  | { readonly kind: 'too-large' };

/**
 * One entry of a server folder, as the server describes it without following a link (lstat).
 * The name is untrusted (R12): the caller checks it before using it as a path.
 */
export interface ServerEntry {
  /** One name, never a path; never `.` or `..`. */
  readonly name: string;
  /** `link`: a symbolic link, never followed. `other`: a socket, a device, a pipe. */
  readonly kind: 'file' | 'folder' | 'link' | 'other';
  /** Bytes, as the server gives it (a link's size is its target's length). */
  readonly size: number;
  /** Modification time in whole seconds since 1970, as the server gives it. */
  readonly mtime: number;
  /** The mode without the kind: permission bits with setuid, setgid and sticky (`0o2755`). */
  readonly mode: number;
}

/**
 * What stat() finds at a path, without following a link (lstat): `link` for a symbolic link,
 * whatever it points to (R16).
 */
export interface StatResult {
  readonly kind: ServerEntry['kind'] | 'not-found';
}

export type ListResult =
  | { readonly kind: 'found'; readonly entries: readonly ServerEntry[] }
  | { readonly kind: 'not-found' }
  /** More than the limit the caller gave; nothing more is read (R21). */
  | { readonly kind: 'too-many' };

/**
 * One logged-in connection. Every path is an absolute ServerPath (ruling 7). A failure is a
 * TransportError; operations may run concurrently (they are pipelined over the connection's
 * channels).
 */
export interface Session {
  readonly caps: Capabilities;
  /** What the server reported for `.` at login, resolved to an absolute path. */
  readonly loginFolder: ServerPath;
  /**
   * Creates or overwrites the file `to`. Its folder must exist (else `not-found`). Not atomic.
   * With a `mode`, the file gets those permission bits on the open handle before its first byte
   * is written (R17), whether it was new or not; a server that cannot set them fails the put.
   * Without one, the server decides (a new file gets its default, an old one keeps its own).
   */
  put(source: Source, to: ServerPath, options?: PutOptions): Promise<void>;
  /**
   * Moves a file, replacing an existing file at `to`. A missing `from` is `not-found`; a folder
   * at `to` is `protocol` with `inTheWay: 'folder'`.
   */
  rename(from: ServerPath, to: ServerPath): Promise<void>;
  /**
   * Deletes a file. A missing file is done, not an error; so is a folder at the path (no file
   * there: it is left as it is). A link is removed itself, never what it points to, folder or
   * file (R16, spec #41 decision 27). Resolves to whether the server changed: false when there
   * was no file or link.
   */
  remove(path: ServerPath): Promise<boolean>;
  /**
   * Creates one folder. An existing folder is done; a missing parent is `not-found`; a file at
   * the path is `protocol` with `inTheWay: 'file'`. Resolves to whether the server changed: false
   * when the folder was there already.
   */
  mkdir(path: ServerPath): Promise<boolean>;
  /**
   * Removes an empty folder. A missing folder is done; a non-empty one, or a file at the path, is
   * left, no error. Resolves to whether the server changed: false when it was missing or left.
   */
  rmdir(path: ServerPath): Promise<boolean>;
  /**
   * What is at `path`, the last name not followed (lstat): a file, a folder, a link (whatever it
   * points to, or nothing) or something else. A missing path, or one whose parent is missing or
   * no folder, is `not-found`. What R16's check asks before writing into a folder (decision 27).
   */
  stat(path: ServerPath): Promise<StatResult>;
  /** Reads a whole file of at most `maxBytes` bytes. */
  read(path: ServerPath, maxBytes: number): Promise<ReadResult>;
  /**
   * The entries of one folder, not recursive, in no set order: at most `maxEntries`, else
   * `too-many`. A missing folder (or parent) is `not-found`; a file at the path is `protocol`
   * with `inTheWay: 'file'`.
   */
  list(folder: ServerPath, maxEntries: number): Promise<ListResult>;
  /**
   * Downloads the file `from`, of `size` bytes, into the new local file `to`, created exclusively
   * (anything already at `to` fails, and is left as it is). Pipelined within its channel's share
   * of `parallel`, with never more chunks in memory than that. It reads at most `size` bytes; a
   * file longer or shorter than `size` (changed since it was listed) is `protocol` with reason
   * `changed`. A missing file is `not-found`; a folder is `protocol` with `inTheWay: 'folder'`.
   * On any failure the local file it created is removed; a local failure passes through as the
   * file system's own error.
   */
  get(from: ServerPath, to: string, size: number): Promise<void>;
  /** Ends the session; later calls fail with `connection-lost`. Closing twice is fine. */
  close(): Promise<void>;
  /**
   * FTPS only (spec #41 decision 10): the certificate the server showed, checked before the login
   * (by the CAs and the host name, or against `tlsFingerprint`). What the target block prints.
   */
  readonly certificate?: ServerCertificate;
  /**
   * The SSH archive (0034), offered beside the SFTP operations on the same connection: present
   * only for an `ssh://` target whose server passed the `tar` probe after login. Absent, every
   * upload goes file by file through put().
   */
  readonly archive?: ArchiveUpload;
}

// ---------------------------------------------------------------------------------------------
// The archive port (0034, spec #41 decision 13): many files sent as one stream, extracted by the
// server's own `tar`. An execution strategy: `execute` chooses the names (temp names, R18) and
// renames them afterwards through the Session; the plan does not know.
// ---------------------------------------------------------------------------------------------

/** One file an archive carries. */
export interface ArchiveFile {
  /** Where it lands, relative to the folder the archive is extracted into. */
  readonly path: RemotePath;
  /** The local file, absolute, read when its turn comes. */
  readonly file: string;
  /** Its size as the plan counted it; a file of another size fails the archive (`changed`). */
  readonly size: number;
}

interface ArchiveOptions {
  /**
   * Hears the files and bytes passed on to the server so far, after each file: what
   * the progress line shows. Passed on is not yet in place: send() resolves for that.
   */
  readonly onSent: (sent: { readonly files: number; readonly bytes: number }) => void;
  /** Ctrl-C: stops the stream at once; send() then fails. */
  readonly signal: AbortSignal | undefined;
}

/**
 * Sends files to the server as one archive, which may travel as several streams side by side
 * (decision 0039; contract suite: testkit's archiveContract).
 * send() puts each file, whole, at its path under `root` (folders made when missing, as `tar`
 * makes them, replacing a file already there) and resolves once the server says every one is in
 * place. A path not in `files` is never touched. On a failure (a TransportError: the stream
 * dropped, stalled past `timeout`, or the server's `tar` failed; `changed` for a local file not
 * the size given), any of the files may be there, whole or in part, and nothing else changed.
 */
export interface ArchiveUpload {
  send(root: ServerPath, files: readonly ArchiveFile[], options: ArchiveOptions): Promise<void>;
}

/**
 * Every server problem maps to one of these (spec #1, transport). `private-key` is the one that
 * is not the server's: the target's key could not be read, so nothing was dialled (decision
 * 0033; deploy and pull stop on it as the Problem `private-key-unreadable`).
 */
export type TransportErrorCode =
  | 'auth'
  | 'host-key'
  | 'unreachable'
  | 'not-found'
  | 'permission'
  | 'quota'
  | 'connection-lost'
  | 'timeout'
  | 'protocol'
  | 'private-key'
  /**
   * FTPS (R8, spec #41 decision 8): TLS refused, or a certificate not trusted. Like `host-key`,
   * exit 4, and always before the user name is sent.
   */
  | 'tls';

/**
 * An FTPS server's TLS certificate as the output shows it (spec #41 decisions 10, 12). Its texts
 * are the server's: printed safely, never trusted.
 */
export interface ServerCertificate {
  /** `CN=ftp.example.com, O=Example`: the certificate's subject, its parts joined by `, `. */
  readonly subject: string;
  readonly issuer: string;
  /** Valid from and until, ISO 8601 (`2026-10-09T06:29:23.000Z`). */
  readonly validFrom: string;
  readonly validTo: string;
  /** SHA-256 of the certificate, colon-separated uppercase hex: what `tlsFingerprint` holds. */
  readonly sha256: string;
}

/** A server's host key as the output shows it: its type (`ssh-ed25519`) and fingerprint. */
export interface HostKeyId {
  readonly type: string;
  /** OpenSSH form, `SHA256:<base64 without padding>`. */
  readonly fingerprint: string;
}

/**
 * What happened, finer than the code (the code decides the exit code). Facts only: report words
 * them (decision 0024); a transport never writes a sentence.
 */
export type TransportReason =
  /** private-key: not a private key sealup can read (OpenSSH or PEM, all its lines). */
  | 'key-unreadable'
  /** private-key: the key is encrypted and the target has no passphrase. */
  | 'passphrase-missing'
  /** private-key: the passphrase does not open the key. */
  | 'passphrase-wrong'
  /** host-key: no key is pinned (deploy stops before connecting; a guard). */
  | 'no-host-key'
  /** host-key: the server sent another key (`received`). */
  | 'other-key'
  /** auth: the server refused the login. */
  | 'login-refused'
  /**
   * tls: the server refused `AUTH TLS` (or to protect the data connections, `PROT P`): it offers
   * no FTPS on that port. Never a fallback to plain FTP (R8).
   */
  | 'tls-refused'
  /**
   * tls: the certificate (`certificate`) is not trusted: no CA vouches for it (self-signed, an
   * unknown issuer) or it is out of date. No `tlsFingerprint` is pinned.
   */
  | 'certificate-untrusted'
  /** tls: the certificate is trusted but names another host. No `tlsFingerprint` is pinned. */
  | 'certificate-name'
  /** tls: the certificate is not the one `tlsFingerprint` pins. */
  | 'certificate-other'
  /** unreachable: the port refused the connection. */
  | 'refused'
  /** unreachable: no host has that name (DNS). */
  | 'no-such-host'
  /** unreachable: the network gives no way to the host. */
  | 'no-route'
  /** unreachable: the server closed the connection before login. */
  | 'closed'
  /** unreachable: the connection broke before login, another way. */
  | 'broken'
  /** unreachable: the server did not finish the SSH handshake in time. */
  | 'handshake'
  /**
   * unreachable: an SSH URL (`sftp://`, `ssh://`) on a port that greeted with FTP's `220`: this
   * port speaks FTP (S19, spec #41 decision 9). Nothing was sent.
   */
  | 'speaks-ftp'
  /** unreachable: Ctrl-C before login. */
  | 'interrupted'
  /** unreachable (connect) or timeout (a request): no answer within `timeoutMs`. */
  | 'no-answer'
  /** protocol: the server did not answer as an SSH server does. */
  | 'not-ssh'
  /** protocol: the server offers no SFTP to this user. */
  | 'no-sftp'
  /** protocol: the server did not answer as an FTP server does (no `220` greeting). */
  | 'not-ftp'
  /**
   * protocol: the server refused to set the mode of the file at `path` (FTP's `SITE CHMOD`,
   * R17); the file holds no content yet.
   */
  | 'mode-refused'
  /** protocol: the server did not tell its login folder. */
  | 'no-login-folder'
  /** connection-lost: the connection dropped. */
  | 'lost'
  /**
   * not-found, permission, quota or protocol: the server answered `operation` on `path` with a
   * failure (`serverSaid`: its own words, when it gave any).
   */
  | 'answer'
  /** protocol: `path` is held by the other kind (`inTheWay`). */
  | 'in-the-way'
  /** protocol: the file at `path` was longer or shorter than the size given (it changed). */
  | 'changed';

/** The Session operation a server answer was for. */
export type TransportOperation =
  | 'upload'
  | 'rename'
  | 'delete'
  | 'mkdir'
  | 'rmdir'
  | 'read'
  | 'look'
  | 'list'
  | 'download';

interface TransportFacts extends ErrorOptions {
  /** For `other-key`: the key the server sent instead of the pinned one. */
  readonly received?: HostKeyId;
  /** The path the operation was on. */
  readonly path?: ServerPath;
  readonly operation?: TransportOperation;
  /** For `no-answer`: how long sealup waited. */
  readonly timeoutMs?: number;
  /** For `answer`: the server's own words for the failure, when it gave any. */
  readonly serverSaid?: string;
  /** For `in-the-way`: what stands at `path`, of the other kind than the operation needs. */
  readonly inTheWay?: 'file' | 'folder';
  /** For the `tls` certificate reasons: the certificate the server showed. */
  readonly certificate?: ServerCertificate;
}

/**
 * A server problem: a code, a reason and facts, never a sentence (report words it). `message` is
 * a technical line for `--debug` only; `cause` keeps the library's own error for it. No field
 * ever holds a secret (R6).
 */
export class TransportError extends Error {
  override readonly name = 'TransportError';
  readonly code: TransportErrorCode;
  readonly reason: TransportReason;
  /** For `other-key`: the key the server sent (a fact for report, never the pinned one). */
  readonly received: HostKeyId | undefined;
  /** The path the operation was on, when it had one. */
  readonly path: ServerPath | undefined;
  readonly operation: TransportOperation | undefined;
  /** For `no-answer`: how long sealup waited, ms. */
  readonly timeoutMs: number | undefined;
  /** For `answer`: the server's own words, when it gave any. */
  readonly serverSaid: string | undefined;
  /**
   * For `in-the-way`: a file where mkdir makes a folder (`file`), or a folder where rename puts
   * a file (`folder`). The operation changed nothing.
   */
  readonly inTheWay: 'file' | 'folder' | undefined;
  /** For the `tls` certificate reasons: the certificate the server showed. */
  readonly certificate: ServerCertificate | undefined;

  constructor(code: TransportErrorCode, reason: TransportReason, facts: TransportFacts = {}) {
    const { received, path, operation, timeoutMs, serverSaid, inTheWay, certificate, ...options } =
      facts;
    const on = [operation, path].filter((part) => part !== undefined).join(' ');
    super(`${code} (${reason})${on === '' ? '' : `: ${on}`}`, options);
    this.code = code;
    this.reason = reason;
    this.received = received;
    this.path = path;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.serverSaid = serverSaid;
    this.inTheWay = inTheWay;
    this.certificate = certificate;
  }
}

/** Opens a logged-in Session to a target (transport; tests pass the memory server's). */
export type Connect = (
  target: Target,
  options: { readonly signal: AbortSignal | undefined },
) => Promise<Session>;

// ---------------------------------------------------------------------------------------------
// The host-key scan port (spec #24 decision 6): what `sealup keyscan` (and `init`) asks of a
// server before any key is trusted. Lane C #31.
// ---------------------------------------------------------------------------------------------

/** A server's host key as a scan shows it: its type, its fingerprint and its OpenSSH line. */
export interface ScannedHostKey extends HostKeyId {
  /** `<type> <base64>`: the line sealup.yml's `hostKey` holds. */
  readonly line: string;
}

interface ScanOptions {
  /** Ctrl-C: stops the scan at once (`unreachable`, reason `interrupted`). */
  readonly signal: AbortSignal | undefined;
  /** How long the scan may take, TCP and key exchange (the target's `timeout`). */
  readonly timeoutMs: number;
  /**
   * The key type to ask for first (a saved key's, `ssh-ed25519`): a server holding several keys
   * then shows that one, so a saved key is compared with its own kind.
   */
  readonly type?: string;
}

/**
 * Shows the key a server proves it holds, and nothing more (R7): the connection ends right after
 * the key exchange, before any authentication method is tried, so no credential is ever sent; it
 * takes none. A failure is a TransportError, as connect's before login.
 */
export type ScanHostKey = (server: ServerUrl, options: ScanOptions) => Promise<ScannedHostKey>;

/** What a certificate scan found: the certificate, and what the normal check says of it. */
export interface CertificateScan {
  readonly certificate: ServerCertificate;
  /**
   * The check a deploy makes without `tlsFingerprint` (R8): `trusted` by the CAs and naming the
   * host; `untrusted` (no CA vouches for it, or out of date); `other-name` (trusted, for another
   * host).
   */
  readonly check: 'trusted' | 'untrusted' | 'other-name';
}

/**
 * Shows the TLS certificate an `ftps://` server presents after `AUTH TLS` (spec #41 decision 12),
 * and nothing more: the connection ends right after the TLS handshake, before any user name is
 * sent; it takes no credential. A server that refuses `AUTH TLS` fails with `tls`/`tls-refused`;
 * any other failure is a TransportError, as connect's before login.
 */
export type ScanCertificate = (
  server: ServerUrl,
  options: Omit<ScanOptions, 'type'>,
) => Promise<CertificateScan>;
