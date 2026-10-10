// The in-memory server: a fake that behaves like a real server because it passes the Session
// contract suite (session-contract.ts). Fast and deterministic, for deploy tests on any OS.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep, setImmediate as yieldTurn } from 'node:timers/promises';
import {
  type ArchiveUpload,
  type ListResult,
  type ReadResult,
  type ScanHostKey,
  type ServerEntry,
  type ServerPath,
  type Session,
  type Source,
  type StatResult,
  TransportError,
  type TransportErrorCode,
  type TransportOperation,
} from '../contracts/index.ts';
import { joinServer, parseServerPath } from '../paths/index.ts';
import { reveal } from '../secret/index.ts';
import type { ArchiveFaults } from './archive-contract.ts';
import type {
  ConnectOptions,
  FaultyContractServer,
  SessionFaults,
} from './session-contract-kit.ts';
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

interface MemoryServerOptions {
  /** What the server reports for `.` at login; created empty. Default `/home/deploy`. */
  readonly loginFolder?: string;
  /**
   * Answer each operation on the next turn of the event loop instead of after a zero timer,
   * which waits up to a timer tick (about 15 ms on Windows): for tests that run many deploys.
   * Operations in flight may then finish in another order than with the default.
   */
  readonly quick?: boolean;
  /** The host key it shows a scan, as an OpenSSH line. Default: the CLI page's ED25519 key. */
  readonly hostKeyLine?: string;
  /**
   * Its sessions carry the SSH archive (0034), as an `ssh://` server with `tar` would: files land
   * as `tar` puts them, once the whole archive was read. Default: none, as on `sftp://`.
   */
  readonly archive?: boolean;
}

interface MemoryServer extends FaultyContractServer, TreeView {
  readonly faults: SessionFaults & ArchiveFaults;
  /** The tree's seedLink, which the contract suite calls too. */
  seedLink(path: string, target: string): void;
  /** The host key it shows, as an OpenSSH line, and its fingerprint. */
  readonly hostKeyLine: string;
  readonly fingerprint: string;
  /** The host-key scan port: it shows the key, logs in to nothing (spec #24 decision 6). */
  readonly scanHostKey: ScanHostKey;
  /** Every login (connect), in order: a scan adds none (R7). */
  logins(): readonly { readonly method: string; readonly accepted: boolean }[];
  /** Moves its clock on by `ms`: what it writes from now on is dated that much later. */
  passTime(ms: number): void;
  /** No connection stays open here: resolves at once. */
  closed(): Promise<void>;
}

/**
 * The CLI page's host key (S04, S07-S20): `ssh-keygen -lf` gives
 * `SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM` for it.
 */
const pageHostKeyLine =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86';

/** The OpenSSH fingerprint of a key line: SHA-256 of the key blob, base64 without padding. */
function fingerprintOf(line: string): string {
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

interface ArmedWrite {
  readonly at: number;
  readonly code: TransportErrorCode;
}

export function createMemoryServer(options: MemoryServerOptions = {}): MemoryServer {
  const tree = createTree(options.loginFolder ?? '/home/deploy');
  /** How far its clock is ahead of this machine's (ms): passTime moves it on. */
  let ahead = 0;
  /** Now on its clock, whole seconds: the date of what it writes. */
  const stamp = (): number => Math.floor((Date.now() + ahead) / 1000);
  const { entries, loginFolder } = tree;

  /** Answers come back later, as from a server. */
  const answer = (): Promise<unknown> => (options.quick === true ? yieldTurn() : sleep(0));
  const hostKeyLine = options.hostKeyLine ?? pageHostKeyLine;
  const logins: { readonly method: string; readonly accepted: boolean }[] = [];
  let writes = 0;
  const armed: ArmedWrite[] = [];
  let loginRefused = false;
  let slowMs = 0;
  let reads = 0;
  /** The reads (`read` and `get`, counted from 1) that drop the connection part-way. */
  const drops: number[] = [];
  /** What a file becomes once the next read of it has looked at its size. */
  const changes = new Map<string, Uint8Array>();

  /** The fault armed for the next archive, if any. */
  let archiveFault: 'drop' | 'fail' | 'stall' | undefined;

  const faults: SessionFaults & ArchiveFaults = {
    dropArchive() {
      archiveFault = 'drop';
    },
    failArchive() {
      archiveFault = 'fail';
    },
    stallArchive() {
      archiveFault = 'stall';
    },
    failWrite(nth, code) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      armed.push({ at: writes + nth, code });
    },
    dropDuringRead(nth) {
      if (!Number.isInteger(nth) || nth < 1) throw new RangeError('nth counts from 1');
      drops.push(reads + nth);
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
  };

  /** The fault armed for the write numbered `n`, if any (consumed). */
  const takeWriteFault = (n: number): TransportErrorCode | undefined => {
    const index = armed.findIndex((fault) => fault.at === n);
    if (index === -1) return undefined;
    const [fault] = armed.splice(index, 1);
    return fault?.code;
  };

  /** Counts a read; whether it is one that drops the connection (consumed). */
  const takeDrop = (): boolean => {
    const index = drops.indexOf(++reads);
    if (index !== -1) drops.splice(index, 1);
    return index !== -1;
  };

  /** The file's bytes once a read has looked at its size: changed, when a test said so. */
  const afterLook = (path: ServerPath, entry: Extract<Entry, { kind: 'file' }>): Uint8Array => {
    const bytes = changes.get(path);
    if (bytes === undefined) return entry.bytes;
    changes.delete(path);
    entries.set(path, { ...entry, bytes });
    return bytes;
  };

  const connect = async (connectOptions: ConnectOptions = {}): Promise<Session> => {
    await answer();
    logins.push({ method: 'password', accepted: !loginRefused });
    if (loginRefused) throw new TransportError('auth', 'login-refused');
    let closed = false;
    const timeoutMs = connectOptions.timeoutMs;

    /** Every operation: checks the session, waits like a server would, then does `work`. */
    const operation = async <T>(work: () => T | Promise<T>): Promise<T> => {
      if (closed) throw lost();
      if (timeoutMs !== undefined && slowMs > timeoutMs) {
        await sleep(timeoutMs);
        throw new TransportError('timeout', 'no-answer', { timeoutMs });
      }
      if (slowMs > 0) await sleep(slowMs);
      else await answer();
      if (closed) throw lost();
      return work();
    };

    const session: Session = {
      caps: { replace: 'posix-rename', setMode: true },
      loginFolder,

      async put(source: Source, to: ServerPath, putOptions = {}): Promise<void> {
        writes++;
        const fault = takeWriteFault(writes);
        const bytes = sourceBytes(source);
        return operation(() => {
          if (fault === 'connection-lost') closed = true;
          if (fault !== undefined) throw injected(fault, to, timeoutMs);
          parentFolder(entries, to, 'upload');
          if (entries.get(to)?.kind === 'folder') throw notAFile(to, 'upload');
          const file = writtenFile(entries.get(to), bytes, stamp());
          // Every byte arrives at once, under the mode asked for, if any (R17).
          const mode = putOptions.mode ?? file.mode;
          entries.set(to, { ...file, mode, firstByteMode: mode });
        });
      },

      rename(from, to) {
        return operation(() => {
          const entry = entries.get(checked(from));
          if (entry === undefined) throw notFound(from, 'rename');
          if (entry.kind !== 'file') throw notAFile(from, 'rename');
          parentFolder(entries, to, 'rename');
          if (entries.get(to)?.kind === 'folder') throw inTheWay('folder', to);
          entries.delete(from);
          entries.set(to, entry);
        });
      },

      remove(path) {
        return operation(() => {
          const entry = entries.get(checked(path));
          // A folder is no file: left as it is.
          if (entry?.kind === 'folder') return false;
          return entries.delete(path);
        });
      },

      mkdir(path) {
        return operation(() => {
          const entry = entries.get(checked(path));
          if (entry?.kind === 'folder') return false;
          if (entry !== undefined) throw inTheWay('file', path);
          parentFolder(entries, path, 'mkdir');
          entries.set(path, newFolder(stamp()));
          return true;
        });
      },

      rmdir(path) {
        return operation(() => {
          const entry = entries.get(checked(path));
          // A file is no folder: left as it is, like a folder that is not empty.
          if (entry === undefined || entry.kind !== 'folder') return false;
          if (hasChildren(entries, path)) return false;
          return entries.delete(path);
        });
      },

      stat(path): Promise<StatResult> {
        // lstat: a link is a link. This server follows no link in a path at all.
        return operation(() => ({ kind: entries.get(checked(path))?.kind ?? 'not-found' }));
      },

      read(path, maxBytes): Promise<ReadResult> {
        const drop = takeDrop();
        return operation((): ReadResult => {
          const entry = entries.get(checked(path));
          if (entry === undefined) return { kind: 'not-found' };
          if (entry.kind !== 'file') throw notAFile(path, 'read');
          if (entry.bytes.length > maxBytes) return { kind: 'too-large' };
          const bytes = afterLook(path, entry);
          if (drop) {
            closed = true;
            throw lost();
          }
          if (bytes.length > maxBytes) return { kind: 'too-large' };
          return { kind: 'found', bytes: Uint8Array.from(bytes), mode: entry.mode };
        });
      },

      get(from, to, size) {
        const drop = takeDrop();
        return operation(() => {
          const entry = entries.get(checked(from));
          if (entry === undefined) throw notFound(from, 'download');
          if (entry.kind === 'folder') throw inTheWay('folder', from);
          if (entry.kind !== 'file') throw notAFile(from, 'download');
          if (entry.bytes.length !== size) throw changed(from);
          const bytes = afterLook(from, entry);
          // Dropped part-way: what had arrived is removed, so nothing is left here.
          if (drop) {
            closed = true;
            throw lost();
          }
          if (bytes.length !== size) throw changed(from);
          // Written at once, like readLocal: created exclusively, so nothing there is replaced.
          writeFileSync(to, bytes, { flag: 'wx' });
        });
      },

      list(folder, maxEntries): Promise<ListResult> {
        return operation((): ListResult => {
          const entry = entries.get(checked(folder));
          if (entry === undefined) return { kind: 'not-found' };
          if (entry.kind !== 'folder') throw inTheWay('file', folder);
          const children = childrenOf(entries, folder);
          if (children.length > maxEntries) return { kind: 'too-many' };
          return { kind: 'found', entries: children.map(([name, child]) => describe(name, child)) };
        });
      },

      async close() {
        closed = true;
      },
    };
    if (options.archive !== true) return session;

    /**
     * The archive as `tar -xmzf - -C <root>` puts it, dated now by the server: every file read
     * first (a drop or Ctrl-C there leaves the server as it was), then each one replaced whole,
     * its folders made. A
     * failed one (failArchive) has put every file before it fails, as a full disk late in a real
     * tar's run would.
     */
    const archive: ArchiveUpload = {
      async send(root, files, { onSent, signal }) {
        if (closed) throw lost();
        checked(root);
        const fault = archiveFault;
        archiveFault = undefined;
        const interrupted = () => new TransportError('unreachable', 'interrupted');
        const aborted = (): boolean => signal?.aborted === true;
        if (aborted()) throw interrupted();
        if (fault === 'stall') {
          const waitMs = timeoutMs ?? 30_000;
          await sleep(waitMs);
          throw new TransportError('timeout', 'no-answer', { timeoutMs: waitMs });
        }
        const read: [ServerPath, Uint8Array][] = [];
        let bytes = 0;
        for (const file of files) {
          const to = joinServer(root, file.path);
          const data = readLocal(file.file);
          if (data.length !== file.size) {
            throw new TransportError('protocol', 'changed', { operation: 'upload', path: to });
          }
          read.push([to, data]);
          bytes += data.length;
          onSent({ files: read.length, bytes });
          await answer();
          if (fault === 'drop') closed = true;
          if (closed) throw lost();
          if (aborted()) throw interrupted();
        }
        if (entries.get(root)?.kind !== 'folder') throw notFound(root, 'upload');
        for (const [to, data] of read) {
          for (let folder = parentOf(to); folder !== root; folder = parentOf(folder)) {
            const held = entries.get(folder);
            if (held === undefined) entries.set(folder, newFolder(stamp()));
            else if (held.kind !== 'folder') throw inTheWay('file', to);
          }
          if (entries.get(to)?.kind === 'folder') throw inTheWay('folder', to);
          entries.set(to, writtenFile(undefined, data, stamp()));
        }
        // Fault failArchive: the disk filled once the files were out; tar says it failed.
        if (fault === 'fail') {
          throw new TransportError('quota', 'answer', {
            operation: 'upload',
            path: root,
            serverSaid: 'tar: Cannot write: Disk quota exceeded',
          });
        }
      },
    };
    return { ...session, archive };
  };

  return {
    loginFolder,
    faults,
    connect,
    hostKeyLine,
    fingerprint: fingerprintOf(hostKeyLine),
    // A scan shows the key and logs in to nothing (R7): no login is counted.
    scanHostKey: async (_server, scanOptions) => {
      if (scanOptions.signal?.aborted === true) {
        throw new TransportError('unreachable', 'interrupted');
      }
      await answer();
      const [type = ''] = hostKeyLine.split(' ');
      return { type, fingerprint: fingerprintOf(hostKeyLine), line: hostKeyLine };
    },
    logins: () => [...logins],
    closed: async () => {},
    passTime(ms) {
      ahead += ms;
    },
    files: tree.files,
    folders: tree.folders,
    seedFile: tree.seedFile,
    seedLink: tree.seedLink,
    seedOther: tree.seedOther,
    seedFolder: tree.seedFolder,
  };
}

/** What a put sends: a secret's value as the SFTP transport sends it (UTF-8, from memory). */
function sourceBytes(source: Source): Uint8Array {
  if ('bytes' in source) return Uint8Array.from(source.bytes);
  if ('secret' in source) return new TextEncoder().encode(reveal(source.secret));
  return readLocal(source.file);
}

/**
 * Read at once, not in the background: operations are then answered in the order they were
 * started, as over one SFTP channel, whatever the disk's timing (an async read let a later put
 * overtake an earlier one under load, and tests flaked).
 */
function readLocal(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

/** Throws not-found unless the parent of `path` is an existing folder. */
function parentFolder(
  entries: ReadonlyMap<string, Entry>,
  path: ServerPath,
  operation: TransportOperation,
): void {
  checked(path);
  const parent = parentOf(path);
  if (entries.get(parent)?.kind !== 'folder') throw notFound(path, operation);
}

/** A caller that passes an unchecked string is a bug in sealup, not a server problem. */
function checked(path: ServerPath): ServerPath {
  const result = parseServerPath(path);
  if (!result.ok) throw new RangeError(`not a ServerPath (${result.problem}): ${path}`);
  return path;
}

/** An entry as list() gives it: a link's size is its target's length, as lstat says. */
function describe(name: string, entry: Entry): ServerEntry {
  const size =
    entry.kind === 'file' ? entry.bytes.length : entry.kind === 'link' ? entry.target.length : 0;
  return { name, kind: entry.kind, size, mtime: entry.mtime, mode: entry.mode };
}

function lost(): TransportError {
  return new TransportError('connection-lost', 'lost');
}

function notFound(path: ServerPath, operation: TransportOperation): TransportError {
  return new TransportError('not-found', 'answer', { path, operation });
}

/** What an injected fault looks like, as a server would send it for an upload. */
function injected(
  code: TransportErrorCode,
  path: ServerPath,
  timeoutMs: number | undefined,
): TransportError {
  switch (code) {
    case 'connection-lost':
      return lost();
    case 'timeout':
      return new TransportError('timeout', 'no-answer', { timeoutMs: timeoutMs ?? 30_000 });
    case 'auth':
      return new TransportError('auth', 'login-refused');
    case 'host-key':
      return new TransportError('host-key', 'other-key');
    case 'unreachable':
      return new TransportError('unreachable', 'broken');
    default:
      return new TransportError(code, 'answer', { path, operation: 'upload' });
  }
}

function inTheWay(found: 'file' | 'folder', path: ServerPath): TransportError {
  return new TransportError('protocol', 'in-the-way', { path, inTheWay: found });
}

/** A file longer or shorter than the size the caller gave: it changed since it was listed. */
function changed(path: ServerPath): TransportError {
  return new TransportError('protocol', 'changed', { path, operation: 'download' });
}

function notAFile(path: ServerPath, operation: TransportOperation): TransportError {
  return new TransportError('protocol', 'answer', { path, operation });
}
