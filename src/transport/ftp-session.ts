// The Session port over a pool of logged-in FTP connections (spec #41 decisions 3–7): what each
// operation means in FTP commands, and which reply becomes which TransportError.
//
// Pool: each operation takes a free connection (first come, first served) and keeps it until it
// ends: FTP runs one command at a time per connection. A connection lost during an operation is a
// dropped connection: that operation, every one waiting and every later one fail with
// connection-lost, as on SFTP's one connection. A connection the session ends itself (a timeout, a
// transfer it cut short, an idle connection the server closed) is only left out; when none is
// left, the session is lost.
//
// Uploads send their STOR in the order they were given a connection, whatever the connection:
// the server sees them in that order (the fault suite's "nth write" counts on it).
//
// FTP replies say little (550 is "not done"), so a failure is read from its code and words, and,
// where the Session's rules need it, from a look at the path: a missing parent is `not-found`, a
// folder or file in the way is `in-the-way`.

import { type FileHandle, open, rm } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import type { Client, FTPError, FTPResponse } from 'basic-ftp';
import {
  type Capabilities,
  type ListResult,
  type ReadResult,
  type ServerCertificate,
  type ServerEntry,
  type ServerPath,
  type Session,
  type Source,
  type StatResult,
  TransportError,
  type TransportErrorCode,
  type TransportOperation,
} from '../contracts/index.ts';
import { parseServerPath } from '../paths/index.ts';
import { reveal } from '../secret/index.ts';
import { changed, inTheWay } from './errors.ts';
import { type Facts, parseListLine, parseMlsxLine } from './ftp-list.ts';
import { connectionLost } from './requests.ts';

/** One logged-in FTP connection, and the hooks the session sets on it. */
export interface FtpLink {
  readonly client: Client;
  /** The session ends it itself: its errors are not a dropped connection. */
  ending: boolean;
  /** EPSV was refused once: PASV from then on. */
  pasv: boolean;
  /** Awaited once the data connection is open, before the next STOR goes out. */
  beforeStore: (() => Promise<void>) | undefined;
  /** Called once a STOR command is on the wire. */
  afterStore: (() => void) | undefined;
  /**
   * FTPS with `tlsFingerprint`: the pinned SHA-256 each data connection's certificate must have
   * (CA checks are off for it, as for the control connection). Undefined otherwise.
   */
  readonly pin: string | undefined;
}

interface FtpSessionOptions {
  readonly loginFolder: ServerPath;
  readonly caps: Capabilities;
  /** FEAT offered MLST: MLSD and MLST, else LIST and CWD/SIZE. */
  readonly mlst: boolean;
  /** basic-ftp's class for a failure reply (4xx, 5xx). */
  readonly replyError: typeof FTPError;
  readonly timeoutMs: number;
  /** FTPS: the certificate the first connection checked. */
  readonly certificate?: ServerCertificate;
}

/**
 * FTPS: a data connection with a new TLS session whose certificate Node's check refused (CA or
 * host name). A `tls` error, so it is never taken for a dropped connection and retried.
 */
export function refusedCertificate(error: unknown): TransportError | undefined {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (typeof code !== 'string') return undefined;
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new TransportError('tls', 'certificate-name', { cause: error });
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) {
    return new TransportError('tls', 'certificate-untrusted', { cause: error });
  }
  return undefined;
}

/** R17: the server cannot give a file its mode before its content (`said`: its words, if any). */
function modeRefused(path: ServerPath, said: string): TransportError {
  return new TransportError('protocol', 'mode-refused', {
    operation: 'upload',
    path,
    ...(said === '' ? {} : { serverSaid: said }),
  });
}

/** A local file's failure: passed through as the file system's own error. */
class LocalError extends Error {}

/** A transfer cut short on purpose: more bytes than the caller allowed. */
class Overflow extends Error {}

/** The reply words without their codes, one line. */
const wordsOf = (message: string): string =>
  message
    .split('\n')
    .map((line) => line.replace(/^\d{3}[ -]?/, '').trim())
    .filter((line) => line !== '')
    .join(' ');

/** What a failure reply means, from its code and the system's words in it. */
function codeOf({ code, message }: FTPResponse): TransportErrorCode {
  if (code === 452 || code === 552 || /quota|no space|disk full|space left/i.test(message)) {
    return 'quota';
  }
  if (/no such file|not found|does not exist|doesn't exist|can't find|cannot find/i.test(message)) {
    return 'not-found';
  }
  if (code === 530 || code === 532 || /permission|denied|not allowed/i.test(message)) {
    return 'permission';
  }
  return 'protocol';
}

function answer(
  reply: FTPResponse,
  operation: TransportOperation,
  path: ServerPath,
  code = codeOf(reply),
): TransportError {
  const said = wordsOf(reply.message);
  return new TransportError(code, 'answer', {
    operation,
    path,
    ...(said === '' ? {} : { serverSaid: said }),
    ...(reply instanceof Error ? { cause: reply } : {}),
  });
}

const isOk = (reply: FTPResponse): boolean => reply.code >= 200 && reply.code < 300;

/** The folder a path is in. */
function parentOf(path: ServerPath): ServerPath {
  const parent = parseServerPath(path.slice(0, path.lastIndexOf('/')) || '/');
  // The parent of a ServerPath is one; `/` is its own.
  return parent.ok ? parent.path : path;
}

/** R4: a path that would split a command is a bug in the caller; it never reaches the server. */
function guard(...paths: readonly string[]): void {
  for (const path of paths) {
    if (/[\r\n\0]/.test(path)) throw new RangeError('a server path with CR, LF or NUL (R4)');
  }
}

/** STOR turns: ticket n's STOR goes out once every earlier ticket's has (or never will). */
function createTurns() {
  let next = 0;
  let served = 0;
  const done = new Set<number>();
  const waiting = new Map<number, () => void>();
  return {
    take: (): number => next++,
    wait: (ticket: number): Promise<void> =>
      ticket <= served ? Promise.resolve() : new Promise((resolve) => waiting.set(ticket, resolve)),
    done(ticket: number): void {
      if (ticket < served) return;
      done.add(ticket);
      while (done.delete(served)) served++;
      waiting.get(served)?.();
      waiting.delete(served);
    },
  };
}

/** Collects at most `max` bytes; one more cuts the transfer short (Overflow). */
class Collector extends Writable {
  readonly parts: Buffer[] = [];
  total = 0;
  private readonly max: number;
  private readonly link: FtpLink;
  constructor(max: number, link: FtpLink) {
    super();
    this.max = max;
    this.link = link;
  }
  override _write(chunk: Buffer, _: BufferEncoding, done: (error?: Error) => void): void {
    this.total += chunk.length;
    if (this.total > this.max) {
      this.link.ending = true;
      done(new Overflow());
      return;
    }
    this.parts.push(chunk);
    done();
  }
}

/** Writes into a local file, at most `size` bytes; one more cuts the transfer short. */
class FileSink extends Writable {
  total = 0;
  private readonly file: FileHandle;
  private readonly size: number;
  private readonly link: FtpLink;
  constructor(file: FileHandle, size: number, link: FtpLink) {
    super();
    this.file = file;
    this.size = size;
    this.link = link;
  }
  override _write(chunk: Buffer, _: BufferEncoding, done: (error?: Error) => void): void {
    this.total += chunk.length;
    if (this.total > this.size) {
      this.link.ending = true;
      done(new Overflow());
      return;
    }
    this.file.write(chunk).then(
      () => done(),
      (error: unknown) => {
        this.link.ending = true;
        done(new LocalError('local write', { cause: error }));
      },
    );
  }
}

const bytesOf = (bytes: Uint8Array): Readable =>
  Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)], { objectMode: false });

export function createFtpSession(links: readonly FtpLink[], options: FtpSessionOptions): Session {
  const { caps, mlst, replyError, timeoutMs } = options;
  const isReply = (error: unknown): error is FTPError => error instanceof replyError;
  const live = new Set(links);
  const free = [...links];
  const waiting: { resolve(link: FtpLink): void; reject(error: Error): void }[] = [];
  let lostCause: unknown;
  let lost = false;
  const turns = createTurns();

  /** Every connection goes; every operation waiting, and every later one, fails. */
  const loseAll = (cause?: unknown): void => {
    if (lost) return;
    lost = true;
    lostCause = cause;
    for (const link of live) {
      link.ending = true;
      link.client.close();
    }
    live.clear();
    free.length = 0;
    for (const waiter of waiting.splice(0)) waiter.reject(connectionLost(cause));
  };

  /** One connection left out (closed); the session goes on with the others, if any. */
  const retire = (link: FtpLink): void => {
    link.ending = true;
    link.client.close();
    if (!live.delete(link)) return;
    const at = free.indexOf(link);
    if (at !== -1) free.splice(at, 1);
    if (live.size === 0) loseAll(lostCause);
  };

  const acquire = (): Promise<FtpLink> => {
    for (;;) {
      if (lost) return Promise.reject(connectionLost(lostCause));
      const link = free.shift();
      if (link === undefined) break;
      // Closed while idle (the server's idle timeout): left out, not a dropped connection.
      if (link.client.closed) retire(link);
      else return Promise.resolve(link);
    }
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };

  const release = (link: FtpLink): void => {
    if (!live.has(link)) return;
    if (link.client.closed) {
      retire(link);
      return;
    }
    const next = waiting.shift();
    if (next !== undefined) next.resolve(link);
    else free.push(link);
  };

  /** The TransportError (or local error) for an error an operation did not handle itself. */
  const settle = (
    link: FtpLink,
    error: unknown,
    operation: TransportOperation,
    path: ServerPath,
  ): unknown => {
    if (error instanceof LocalError) return error.cause;
    if (error instanceof TransportError) return error;
    const refused = refusedCertificate(error);
    if (refused !== undefined) {
      loseAll(error);
      return refused;
    }
    if (lost) return connectionLost(error);
    if (link.ending) {
      retire(link);
      return error;
    }
    if (isReply(error)) {
      // 421: the server is closing the connection.
      if (error.code !== 421) return answer(error, operation, path);
      loseAll(error);
      return connectionLost(error);
    }
    const message = error instanceof Error ? error.message : '';
    // basic-ftp closes a connection whose reply or data stalls for `timeout`.
    if (/^Timeout/.test(message)) {
      retire(link);
      return new TransportError('timeout', 'no-answer', {
        timeoutMs,
        operation,
        path,
        cause: error,
      });
    }
    loseAll(error);
    // R21: basic-ftp refuses a control reply over 64 kB and closes the connection.
    if (/control response exceeded/i.test(message)) {
      return new TransportError('protocol', 'answer', { operation, path, cause: error });
    }
    return connectionLost(error);
  };

  /** Runs `work` on a connection of its own, start to end. */
  const run = async <T>(
    operation: TransportOperation,
    path: ServerPath,
    work: (link: FtpLink) => Promise<T>,
  ): Promise<T> => {
    const link = await acquire();
    try {
      return await work(link);
    } catch (error) {
      throw settle(link, error, operation, path);
    } finally {
      release(link);
    }
  };

  const reply = (link: FtpLink, command: string): Promise<FTPResponse> => {
    guard(command);
    return link.client.sendIgnoringError(command);
  };

  /** What is at `path` (lstat): MLST, else CWD (a folder) then SIZE (a file). */
  const look = async (link: FtpLink, path: ServerPath): Promise<Facts | undefined> => {
    if (mlst) {
      const found = await reply(link, `MLST ${path}`);
      if (found.code !== 250) return undefined;
      const line = found.message.split('\n').find((text) => text.startsWith(' '));
      // A folder may describe itself as the current one (cdir).
      const facts = line?.slice(1).replace(/(^|;)type=[cp]dir(?=;)/i, '$1type=dir');
      return facts === undefined ? undefined : parseMlsxLine(facts)?.facts;
    }
    if (isOk(await reply(link, `CWD ${path}`))) {
      return { kind: 'folder', size: 0, mtime: 0, mode: 0 };
    }
    const size = await reply(link, `SIZE ${path}`);
    if (size.code !== 213) return undefined;
    const bytes = Number.parseInt(size.message.slice(4), 10);
    return { kind: 'file', size: Number.isSafeInteger(bytes) ? bytes : -1, mtime: 0, mode: 0 };
  };

  const kindOf = async (link: FtpLink, path: ServerPath): Promise<Facts['kind'] | 'none'> =>
    (await look(link, path))?.kind ?? 'none';

  /**
   * The raw listing of `folder` (MLSD), or of the current folder (LIST -a, also on an MLSD server
   * when `format` says so).
   */
  const listText = async (
    link: FtpLink,
    folder: ServerPath | '',
    format: 'mlsd' | 'list' = mlst ? 'mlsd' : 'list',
  ): Promise<string> => {
    let text = '';
    link.client.availableListCommands = [format === 'mlsd' ? 'MLSD' : 'LIST -a'];
    link.client.parseList = (raw) => {
      text = raw;
      return [];
    };
    guard(folder);
    await link.client.list(folder);
    return text;
  };

  /** The entries of a listing's text; names that are paths are left out (R12). */
  const entriesOf = (text: string, format: 'mlsd' | 'list' = mlst ? 'mlsd' : 'list') => {
    const now = Math.floor(Date.now() / 1000);
    const entries: ServerEntry[] = [];
    let unread = 0;
    for (const line of text.split(/\r?\n/)) {
      const parsed = format === 'mlsd' ? parseMlsxLine(line) : parseListLine(line, now);
      if (parsed === undefined) {
        // Not counted: blank, `total N`, and the `.` and `..` lines the parsers leave out.
        if (line.trim() !== '' && !/^total \d+$|\s\.\.?$/.test(line)) unread++;
        continue;
      }
      if (/[/\0]/.test(parsed.name)) continue;
      entries.push({ name: parsed.name, ...parsed.facts });
    }
    return { entries, unread };
  };

  /**
   * The facts of one entry, read from its folder's `LIST -a` (`ls -l` lines, which show a link as
   * a link), or `unreadable` when that listing is in another form. Undefined: not there.
   */
  const listedEntry = async (
    link: FtpLink,
    path: ServerPath,
  ): Promise<Facts | undefined | 'unreadable'> => {
    if (!isOk(await reply(link, `CWD ${parentOf(path)}`))) return undefined;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const { entries, unread } = entriesOf(await listText(link, '', 'list'), 'list');
    const found = entries.find((entry) => entry.name === name);
    return found === undefined && entries.length === 0 && unread > 0 ? 'unreadable' : found;
  };

  /** The facts of one entry, read from its folder's listing (LIST servers: for its mode). */
  const entryIn = async (link: FtpLink, path: ServerPath): Promise<Facts | undefined> => {
    if (mlst) return look(link, path);
    const found = await listedEntry(link, path);
    return found === 'unreadable' ? undefined : found;
  };

  /**
   * lstat: the parent folder's `LIST -a`, on every server. MLST cannot be trusted with a link:
   * ProFTPD's describes what the link points to, and nothing for a dangling one (CWD and SIZE
   * follow a link too). `/` has no parent and is no link: CWD. Where LIST is in a form other than
   * `ls -l` lines (a Windows server), MLST is all there is. A path the server will not describe is
   * not found.
   */
  const stat = async (link: FtpLink, path: ServerPath): Promise<StatResult> => {
    const listed = path === '/' ? await look(link, path) : await listedEntry(link, path);
    const facts = listed === 'unreadable' ? (mlst ? await look(link, path) : undefined) : listed;
    return { kind: facts?.kind ?? 'not-found' };
  };

  /** One upload command; with a ticket, its STOR waits its turn. */
  const store = async (
    link: FtpLink,
    verb: 'STOR' | 'APPE',
    source: Source | undefined,
    to: ServerPath,
    ticket?: number,
  ): Promise<void> => {
    let stream: Readable;
    if (source === undefined) stream = bytesOf(new Uint8Array());
    else if ('bytes' in source) stream = bytesOf(source.bytes);
    // A secret's value is revealed here, in memory, never written to the local disk (R17).
    else if ('secret' in source) stream = bytesOf(Buffer.from(reveal(source.secret), 'utf8'));
    else {
      let file: FileHandle;
      try {
        file = await open(source.file, 'r');
      } catch (error) {
        throw new LocalError('local read', { cause: error });
      }
      stream = file.createReadStream();
    }
    stream.once('error', () => {
      // basic-ftp closes the connection on a source error: the session's own doing.
      link.ending = true;
    });
    if (ticket !== undefined) {
      link.beforeStore = () => turns.wait(ticket);
      link.afterStore = () => turns.done(ticket);
    }
    try {
      guard(to);
      await (verb === 'STOR'
        ? link.client.uploadFrom(stream, to)
        : link.client.appendFrom(stream, to));
    } catch (error) {
      if (!isReply(error)) throw error;
      const code = codeOf(error);
      if (code === 'quota' || code === 'not-found') throw answer(error, 'upload', to, code);
      if ((await kindOf(link, parentOf(to))) === 'none') {
        throw answer(error, 'upload', to, 'not-found');
      }
      throw answer(error, 'upload', to, code);
    } finally {
      link.beforeStore = undefined;
      link.afterStore = undefined;
      stream.destroy();
    }
  };

  const put = (link: FtpLink, source: Source, to: ServerPath, mode?: number): Promise<void> => {
    const ticket = turns.take();
    const work = async (): Promise<void> => {
      if (mode === undefined) return store(link, 'STOR', source, to, ticket);
      // R17: an empty file, its mode, then the content: no byte is ever readable by others.
      await store(link, 'STOR', undefined, to, ticket);
      const chmod = await reply(link, `SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${to}`);
      if (!isOk(chmod)) throw modeRefused(to, wordsOf(chmod.message));
      try {
        await store(link, 'APPE', source, to);
      } catch (error) {
        if (
          !(error instanceof TransportError) ||
          !['protocol', 'permission'].includes(error.code)
        ) {
          throw error;
        }
        // APPE refused (ProFTPD without AllowStoreRestart, Debian's own config): STOR over the
        // empty file instead, which is safe only where STOR keeps the file and its mode. An empty
        // STOR shows that first; a server that makes a new file gets no byte of the content.
        await store(link, 'STOR', undefined, to);
        if ((await entryIn(link, to))?.mode !== mode) throw modeRefused(to, error.serverSaid ?? '');
        await store(link, 'STOR', source, to);
      }
    };
    return work().finally(() => turns.done(ticket));
  };

  /** RNFR then RNTO: undefined when done, else the refusing reply and which step gave it. */
  const renameOnce = async (
    link: FtpLink,
    from: ServerPath,
    to: ServerPath,
  ): Promise<{ step: 'from' | 'to'; reply: FTPResponse } | undefined> => {
    const asked = await reply(link, `RNFR ${from}`);
    if (asked.code !== 350) return { step: 'from', reply: asked };
    const moved = await reply(link, `RNTO ${to}`);
    return isOk(moved) ? undefined : { step: 'to', reply: moved };
  };

  const rename = async (link: FtpLink, from: ServerPath, to: ServerPath): Promise<void> => {
    const refused = await renameOnce(link, from, to);
    if (refused === undefined) return;
    if (refused.step === 'from') {
      const missing = (await kindOf(link, from)) === 'none';
      throw answer(refused.reply, 'rename', from, missing ? 'not-found' : undefined);
    }
    const atTo = await kindOf(link, to);
    if (atTo === 'folder') throw inTheWay('folder', to);
    if (atTo === 'file' && caps.replace === 'unlink-then-rename') {
      // RNTO does not replace on this server: remove the old file, then rename (Capabilities).
      await reply(link, `DELE ${to}`);
      const again = await renameOnce(link, from, to);
      if (again === undefined) return;
      throw answer(again.reply, 'rename', from);
    }
    const noParent = (await kindOf(link, parentOf(to))) === 'none';
    throw answer(refused.reply, 'rename', from, noParent ? 'not-found' : undefined);
  };

  const remove = async (link: FtpLink, path: ServerPath): Promise<boolean> => {
    const deleted = await reply(link, `DELE ${path}`);
    if (isOk(deleted)) return true;
    const kind = await kindOf(link, path);
    // A missing file is done; a folder is no file there, left as it is.
    if (kind === 'none' || kind === 'folder') return false;
    throw answer(deleted, 'delete', path);
  };

  const mkdir = async (link: FtpLink, path: ServerPath): Promise<boolean> => {
    const made = await reply(link, `MKD ${path}`);
    if (isOk(made)) return true;
    const kind = await kindOf(link, path);
    if (kind === 'folder') return false;
    if (kind !== 'none') throw inTheWay('file', path);
    const noParent = (await kindOf(link, parentOf(path))) === 'none';
    throw answer(made, 'mkdir', path, noParent ? 'not-found' : undefined);
  };

  const rmdir = async (link: FtpLink, path: ServerPath): Promise<boolean> => {
    const removed = await reply(link, `RMD ${path}`);
    if (isOk(removed)) return true;
    const kind = await kindOf(link, path);
    // Missing, a file, or a folder that is not empty (ruling 11): left as it is. FTP gives the
    // same reply for a folder it may not remove; only words that say so make it an error.
    if (kind === 'folder' && codeOf(removed) === 'permission') {
      throw answer(removed, 'rmdir', path, 'permission');
    }
    return false;
  };

  const read = async (link: FtpLink, path: ServerPath, maxBytes: number): Promise<ReadResult> => {
    const facts = await entryIn(link, path);
    if (facts === undefined) return { kind: 'not-found' };
    if (facts.kind === 'folder') throw inTheWay('folder', path);
    if (facts.size > maxBytes) return { kind: 'too-large' };
    // Read up to one byte over the limit, whatever size the server gave (R21).
    const sink = new Collector(maxBytes, link);
    try {
      await link.client.downloadTo(sink, path);
    } catch (error) {
      if (error instanceof Overflow) {
        retire(link);
        return { kind: 'too-large' };
      }
      if (!isReply(error)) throw error;
      if ((await kindOf(link, path)) === 'none') return { kind: 'not-found' };
      throw answer(error, 'read', path);
    }
    return { kind: 'found', bytes: new Uint8Array(Buffer.concat(sink.parts)), mode: facts.mode };
  };

  const list = async (
    link: FtpLink,
    folder: ServerPath,
    maxEntries: number,
  ): Promise<ListResult> => {
    /** The folder could not be listed: missing, a file in the way, or a refusal. */
    const refused = async (said: FTPResponse): Promise<ListResult> => {
      const kind = await kindOf(link, folder);
      if (kind === 'none') return { kind: 'not-found' };
      if (kind !== 'folder') throw inTheWay('file', folder);
      throw answer(said, 'list', folder);
    };
    let text: string;
    try {
      if (!mlst) {
        // LIST of a file lists the file: change into the folder first, then list it.
        const entered = await reply(link, `CWD ${folder}`);
        if (!isOk(entered)) return await refused(entered);
      }
      text = await listText(link, mlst ? folder : '');
    } catch (error) {
      if (isReply(error)) return refused(error);
      // basic-ftp stops a listing past maxListingBytes; the connection holds a reply to come.
      if (error instanceof Error && /maximum bytes exceeded/i.test(error.message)) {
        retire(link);
        return { kind: 'too-many' };
      }
      throw error;
    }
    const { entries } = entriesOf(text);
    return entries.length > maxEntries ? { kind: 'too-many' } : { kind: 'found', entries };
  };

  const get = async (link: FtpLink, from: ServerPath, to: string, size: number): Promise<void> => {
    const facts = await look(link, from);
    if (facts === undefined) {
      throw new TransportError('not-found', 'answer', { operation: 'download', path: from });
    }
    if (facts.kind === 'folder') throw inTheWay('folder', from);
    if (facts.size !== size) throw changed(from);
    let file: FileHandle;
    try {
      // Exclusive: anything already at `to` fails here, and is left as it is.
      file = await open(to, 'wx');
    } catch (error) {
      throw new LocalError('local open', { cause: error });
    }
    const sink = new FileSink(file, size, link);
    try {
      await link.client.downloadTo(sink, from);
      // Fewer bytes than `size`: the file shrank once its size was looked at.
      if (sink.total !== size) throw changed(from);
      await file.close();
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(to, { force: true });
      if (error instanceof Overflow) {
        retire(link);
        throw changed(from);
      }
      if (isReply(error)) throw answer(error, 'download', from);
      throw error;
    }
  };

  let closed = false;
  const session: Session = {
    caps,
    loginFolder: options.loginFolder,
    ...(options.certificate === undefined ? {} : { certificate: options.certificate }),
    put: async (source, to, putOptions) => {
      guard(to);
      return run('upload', to, (link) => put(link, source, to, putOptions?.mode));
    },
    rename: async (from, to) => {
      guard(from, to);
      return run('rename', from, (link) => rename(link, from, to));
    },
    remove: async (path) => {
      guard(path);
      return run('delete', path, (link) => remove(link, path));
    },
    mkdir: async (path) => {
      guard(path);
      return run('mkdir', path, (link) => mkdir(link, path));
    },
    rmdir: async (path) => {
      guard(path);
      return run('rmdir', path, (link) => rmdir(link, path));
    },
    stat: async (path) => {
      guard(path);
      return run('look', path, (link) => stat(link, path));
    },
    read: async (path, maxBytes) => {
      guard(path);
      return run('read', path, (link) => read(link, path, maxBytes));
    },
    list: async (folder, maxEntries) => {
      guard(folder);
      return run('list', folder, (link) => list(link, folder, maxEntries));
    },
    get: async (from, to, size) => {
      guard(from);
      return run('download', from, (link) => get(link, from, to, size));
    },
    async close() {
      if (closed) return;
      closed = true;
      loseAll();
    },
  };
  return session;
}
