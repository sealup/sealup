// The Session port over the SFTP channels of one connection: what each operation means in SFTP v3
// requests, which channel carries it, and which server answer becomes which TransportError.
//
// Each operation picks the open channel with the fewest requests waiting and in flight, and sends
// all its requests there (a file handle belongs to the channel that opened it). `parallel` is
// split evenly over the open channels, the first ones taking the remainder; a lost channel's
// share goes to the channels left, so `parallel` stays the session's total.

import { type FileHandle, open, rm } from 'node:fs/promises';
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import {
  type Capabilities,
  type ListResult,
  type PutOptions,
  type ReadResult,
  type ServerEntry,
  type ServerPath,
  type Session,
  type Source,
  type StatResult,
  TransportError,
  type TransportErrorCode,
  type TransportOperation,
} from '../contracts/index.ts';
import { reveal } from '../secret/index.ts';
import { changed, inTheWay } from './errors.ts';
import { connectionLost, createRequests, type Requests, StatusError } from './requests.ts';

/** SFTP v3 status codes (draft-ietf-secsh-filexfer-02), and the v5+ codes for a full disk. */
const status = {
  eof: 1,
  noSuchFile: 2,
  permissionDenied: 3,
  failure: 4,
  noConnection: 6,
  connectionLost: 7,
  noSpaceOnFilesystem: 14,
  quotaExceeded: 15,
} as const;

/**
 * Bytes per READ or WRITE request: under ssh2's limit for servers that are not OpenSSH (34,000
 * bytes less 2 KiB of overhead), so one call is one request on the wire.
 */
const chunkSize = 31 * 1024;

interface SessionOptions {
  readonly loginFolder: ServerPath;
  readonly caps: Capabilities;
  readonly parallel: number;
  readonly timeoutMs: number;
}

/** One SFTP channel and its requests. */
export interface Channel {
  readonly sftp: SFTPWrapper;
  readonly requests: Requests;
  readonly send: Requests['send'];
}

/**
 * A channel, watched from the moment it opens: once the server ends or closes it, it is lost (its
 * requests fail with connection-lost, and no operation picks it), even before the session exists;
 * its `error` is handled ('end' and 'close' follow). It may send one request at once until the
 * session gives it its share of `parallel`.
 */
export function watchChannel(sftp: SFTPWrapper, timeoutMs: number): Channel {
  const requests = createRequests(1, timeoutMs);
  const lose = (): void => requests.lose();
  sftp.on('end', lose);
  sftp.on('close', lose);
  sftp.on('error', () => {
    // 'end' and 'close' follow; the requests in flight fail there.
  });
  return { sftp, requests, send: requests.send };
}

/** `parallel` split evenly over `count` channels, the first ones taking the remainder. */
function shares(parallel: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => Math.floor(parallel / count) + (i < parallel % count ? 1 : 0),
  );
}

/**
 * A Session over `opened` (at least one, the first being the one that logged in), each watched
 * since it opened (watchChannel).
 */
export function createSftpSession(
  client: Client,
  opened: readonly [Channel, ...Channel[]],
  options: SessionOptions,
): Session {
  /** `parallel` split over the channels still open: a lost channel's share goes to the others. */
  const share = (): void => {
    const open = opened.filter((channel) => !channel.requests.lost);
    const split = shares(options.parallel, open.length);
    open.forEach((channel, i) => {
      channel.requests.limit = split[i] ?? 1;
    });
  };
  share();
  let closed = false;
  let gone = false;
  for (const channel of opened) {
    // The server closed this channel alone (watchChannel marks it lost first): its operations
    // fail with connection-lost, the later ones go to the other channels, and so does its share.
    channel.sftp.on('end', share);
    channel.sftp.on('close', share);
  }
  client.on('close', () => {
    gone = true;
    for (const channel of opened) channel.requests.lose();
  });
  client.on('error', () => {
    // 'close' follows; the operations in flight fail there.
  });

  /**
   * The open channel with the fewest requests waiting and in flight (the first on a tie); when
   * every channel is lost, the first, whose requests fail with connection-lost.
   */
  const pick = (): Channel => {
    let best: Channel | undefined;
    for (const channel of opened) {
      if (channel.requests.lost) continue;
      if (best === undefined || channel.requests.load < best.requests.load) best = channel;
    }
    return best ?? (opened[0] as Channel);
  };

  /** What is at `path`: a file, a folder, or nothing. */
  const kindOf = async (
    { sftp, send }: Channel,
    path: ServerPath,
  ): Promise<'file' | 'folder' | 'none'> => {
    try {
      const stats = await send<Stats>((done) => sftp.stat(path, done));
      return stats.isDirectory() ? 'folder' : 'file';
    } catch (error) {
      if (isStatus(error, status.noSuchFile)) return 'none';
      throw failure(error, 'look', path);
    }
  };

  const closeHandle = ({ sftp, send }: Channel, handle: Buffer): Promise<void> =>
    send<void>((done) => sftp.close(handle, done));

  const writeAll = async (
    { sftp, requests, send }: Channel,
    handle: Buffer,
    source: Source,
  ): Promise<void> => {
    if (!('file' in source)) {
      // A secret's value is revealed here, in memory, and never written to the local disk (R17).
      const bytes =
        'secret' in source
          ? Buffer.from(reveal(source.secret), 'utf8')
          : Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.length);
      await settleAll(
        chunks(bytes.length).map(([at, length]) =>
          send<void>((done) => sftp.write(handle, bytes, at, length, at, done)),
        ),
      );
      return;
    }
    const file = await open(source.file, 'r');
    try {
      const { size } = await file.stat();
      await settleAll(
        chunks(size).map(([at, length]) =>
          // The slot is taken before the disk read, so at most `parallel` chunks sit in memory.
          requests.slot(async (wire) => {
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await file.read(buffer, 0, length, at);
            return wire<void>((done) => sftp.write(handle, buffer, 0, bytesRead, at, done));
          }),
        ),
      );
    } finally {
      await file.close();
    }
  };

  const remove = async (channel: Channel, path: ServerPath): Promise<boolean> => {
    const { sftp, send } = channel;
    try {
      await send<void>((done) => sftp.unlink(path, done));
      return true;
    } catch (error) {
      if (isStatus(error, status.noSuchFile)) return false;
      // unlink refuses a folder (a failure, or permission denied): it is no file, left as it is.
      if (error instanceof StatusError && (await kindOf(channel, path)) === 'folder') return false;
      throw failure(error, 'delete', path);
    }
  };

  const rename = async (channel: Channel, from: ServerPath, to: ServerPath): Promise<void> => {
    const { sftp, send } = channel;
    /** A failed rename onto a folder: the folder is in the way (it changed nothing). */
    const folderInTheWay = async (error: unknown): Promise<boolean> =>
      isStatus(error, status.failure) && (await kindOf(channel, to)) === 'folder';
    if (options.caps.replace === 'posix-rename') {
      try {
        await send<void>((done) => sftp.ext_openssh_rename(from, to, done));
      } catch (error) {
        if (await folderInTheWay(error)) throw inTheWay('folder', to);
        throw failure(error, 'rename', from);
      }
      return;
    }
    try {
      await send<void>((done) => sftp.rename(from, to, done));
    } catch (error) {
      if (await folderInTheWay(error)) throw inTheWay('folder', to);
      // SFTP v3 RENAME does not replace: remove the old file, then rename (Capabilities).
      if (!isStatus(error, status.failure) || (await kindOf(channel, to)) !== 'file') {
        throw failure(error, 'rename', from);
      }
      await remove(channel, to);
      try {
        await send<void>((done) => sftp.rename(from, to, done));
      } catch (again) {
        throw failure(again, 'rename', from);
      }
    }
  };

  const put = async (
    channel: Channel,
    source: Source,
    to: ServerPath,
    { mode }: PutOptions = {},
  ): Promise<void> => {
    const { sftp, send } = channel;
    // The OPEN is asked for first, so uploads reach the server in the order they started. With
    // a mode, a new file is created with it (less the server's umask).
    const opening = send<Buffer>((done) =>
      mode === undefined ? sftp.open(to, 'w', done) : sftp.open(to, 'w', { mode }, done),
    );
    let handle: Buffer;
    try {
      handle = await opening;
    } catch (error) {
      throw failure(error, 'upload', to);
    }
    let first: unknown;
    try {
      // R17: the exact mode on the handle before the first byte, for an old file too.
      if (mode !== undefined) await send<void>((done) => sftp.fchmod(handle, mode, done));
      await writeAll(channel, handle, source);
    } catch (error) {
      first = error;
    }
    try {
      await closeHandle(channel, handle);
    } catch (error) {
      first ??= error;
    }
    if (first !== undefined) throw failure(first, 'upload', to);
  };

  const mkdir = async (channel: Channel, path: ServerPath): Promise<boolean> => {
    const { sftp, send } = channel;
    try {
      await send<void>((done) => sftp.mkdir(path, done));
      return true;
    } catch (error) {
      if (isStatus(error, status.noSuchFile) || !(error instanceof StatusError)) {
        throw failure(error, 'mkdir', path);
      }
      // SFTP v3 has no "already exists": a failure on an existing folder is done.
      const kind = await kindOf(channel, path);
      if (kind === 'folder') return false;
      if (kind === 'file') throw inTheWay('file', path);
      throw failure(error, 'mkdir', path);
    }
  };

  const rmdir = async ({ sftp, send }: Channel, path: ServerPath): Promise<boolean> => {
    try {
      await send<void>((done) => sftp.rmdir(path, done));
      return true;
    } catch (error) {
      if (isStatus(error, status.noSuchFile)) return false;
      if (!isStatus(error, status.failure)) throw failure(error, 'rmdir', path);
      // A folder that is not empty is left as it is (ruling 11); so is a file (it is no folder).
      return false;
    }
  };

  /** LSTAT: the last name is never followed. OpenSSH answers ENOTDIR as no such file. */
  const stat = async ({ sftp, send }: Channel, path: ServerPath): Promise<StatResult> => {
    try {
      const stats = await send<Stats>((done) => sftp.lstat(path, done));
      return { kind: kindOfMode(stats.mode) };
    } catch (error) {
      if (isStatus(error, status.noSuchFile)) return { kind: 'not-found' };
      throw failure(error, 'look', path);
    }
  };

  const read = async (
    channel: Channel,
    path: ServerPath,
    maxBytes: number,
  ): Promise<ReadResult> => {
    const { sftp, send } = channel;
    let handle: Buffer;
    try {
      handle = await send<Buffer>((done) => sftp.open(path, 'r', done));
    } catch (error) {
      if (isStatus(error, status.noSuchFile)) return { kind: 'not-found' };
      throw failure(error, 'read', path);
    }
    try {
      const stats = await send<Stats>((done) => sftp.fstat(handle, done));
      if (stats.size > maxBytes) return { kind: 'too-large' };
      const parts: Buffer[] = [];
      let total = 0;
      // Read past the size the server gave, up to one byte over the limit (R21).
      while (total <= maxBytes) {
        const length = Math.min(chunkSize, maxBytes + 1 - total);
        const buffer = Buffer.alloc(length);
        const read = await send<number>((done) =>
          sftp.read(handle, buffer, 0, length, total, (error, bytesRead) => done(error, bytesRead)),
        );
        if (read === 0) break;
        parts.push(buffer.subarray(0, read));
        total += read;
      }
      if (total > maxBytes) return { kind: 'too-large' };
      return {
        kind: 'found',
        bytes: new Uint8Array(Buffer.concat(parts)),
        mode: stats.mode & 0o7777,
      };
    } catch (error) {
      throw failure(error, 'read', path);
    } finally {
      await closeHandle(channel, handle).catch(() => {
        // Reading is done; a handle the server fails to close changes nothing.
      });
    }
  };

  const list = async (
    channel: Channel,
    folder: ServerPath,
    maxEntries: number,
  ): Promise<ListResult> => {
    const { sftp, send } = channel;
    let handle: Buffer;
    try {
      handle = await send<Buffer>((done) => sftp.opendir(folder, done));
    } catch (error) {
      // OpenSSH answers a file (ENOTDIR) as no such file, like a missing folder.
      if (isStatus(error, status.noSuchFile)) {
        if ((await kindOf(channel, folder)) === 'file') throw inTheWay('file', folder);
        return { kind: 'not-found' };
      }
      throw failure(error, 'list', folder);
    }
    try {
      const entries: ServerEntry[] = [];
      for (;;) {
        let names: FileEntryWithStats[];
        try {
          names = await send<FileEntryWithStats[]>((done) => sftp.readdir(handle, done));
        } catch (error) {
          if (isStatus(error, status.eof)) break;
          throw error;
        }
        for (const { filename, attrs } of names) {
          if (filename === '.' || filename === '..') continue;
          entries.push(entryOf(filename, attrs));
        }
        // Over the limit: no further READDIR is sent (R21).
        if (entries.length > maxEntries) return { kind: 'too-many' };
      }
      return { kind: 'found', entries };
    } catch (error) {
      throw failure(error, 'list', folder);
    } finally {
      await closeHandle(channel, handle).catch(() => {
        // Listing is done; a handle the server fails to close changes nothing.
      });
    }
  };

  const get = async (
    channel: Channel,
    from: ServerPath,
    to: string,
    size: number,
  ): Promise<void> => {
    const { sftp, requests, send } = channel;
    let handle: Buffer;
    try {
      handle = await send<Buffer>((done) => sftp.open(from, 'r', done));
    } catch (error) {
      if (isStatus(error, status.failure) && (await kindOf(channel, from)) === 'folder') {
        throw inTheWay('folder', from);
      }
      throw failure(error, 'download', from);
    }
    let local: FileHandle | undefined;
    try {
      const stats = await send<Stats>((done) => sftp.fstat(handle, done));
      if (stats.isDirectory()) throw inTheWay('folder', from);
      if (stats.size !== size) throw changed(from);
      // Exclusive: anything already at `to` fails here, and is left as it is.
      const file = await open(to, 'wx');
      local = file;
      /** Up to `length` bytes at `at`, into `buffer` from `offset`: 0 at the end of the file. */
      const readAt = (
        wire: typeof send,
        buffer: Buffer,
        offset: number,
        length: number,
        at: number,
      ): Promise<number> =>
        wire<number>((done) =>
          sftp.read(handle, buffer, offset, length, at, (error, bytesRead) =>
            done(error, bytesRead),
          ),
        );
      await settleAll([
        // One byte past `size`: any answer but the end of the file means the file grew.
        readAt(send, Buffer.alloc(1), 0, 1, size).then((bytesRead) => {
          if (bytesRead > 0) throw changed(from);
        }),
        ...chunks(size).map(([at, length]) =>
          // The slot is held until the chunk is on the disk: at most the channel's share of
          // `parallel` chunks sit in memory.
          requests.slot(async (wire) => {
            const buffer = Buffer.allocUnsafe(length);
            for (let got = 0; got < length; ) {
              const bytesRead = await readAt(wire, buffer, got, length - got, at + got);
              // The end of the file before `size`: it shrank.
              if (bytesRead === 0) throw changed(from);
              got += bytesRead;
            }
            await file.write(buffer, 0, length, at);
          }),
        ),
      ]);
      local = undefined;
      await file.close();
    } catch (error) {
      if (local !== undefined) {
        await local.close().catch(() => undefined);
        await rm(to, { force: true });
      }
      throw failure(error, 'download', from);
    } finally {
      await closeHandle(channel, handle).catch(() => {
        // Downloading is done; a handle the server fails to close changes nothing.
      });
    }
  };

  // Each operation runs on the channel picked when it starts.
  const session: Session = {
    caps: options.caps,
    loginFolder: options.loginFolder,
    put: (source, to, putOptions) => put(pick(), source, to, putOptions),
    rename: (from, to) => rename(pick(), from, to),
    remove: (path) => remove(pick(), path),
    mkdir: (path) => mkdir(pick(), path),
    rmdir: (path) => rmdir(pick(), path),
    stat: (path) => stat(pick(), path),
    read: (path, maxBytes) => read(pick(), path, maxBytes),
    list: (folder, maxEntries) => list(pick(), folder, maxEntries),
    get: (from, to, size) => get(pick(), from, to, size),

    async close() {
      if (closed) return;
      closed = true;
      for (const channel of opened) channel.requests.lose();
      if (gone) return;
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 2_000);
        client.once('close', () => {
          clearTimeout(fallback);
          resolve();
        });
        client.end();
      });
    },
  };
  return session;
}

/** [position, length] of each chunk of a file of `size` bytes. */
function chunks(size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let at = 0; at < size; at += chunkSize) out.push([at, Math.min(chunkSize, size - at)]);
  return out;
}

/** Waits for every request (in-flight ones finish), then throws the first failure, if any. */
async function settleAll(work: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}

/**
 * The kind in a mode's kind bits (S_IFMT), as lstat gives them. A switch, not an object keyed by
 * octal literals: Biome 2.5.15's fix rewrites such keys to wrong decimal numbers.
 */
function kindOfMode(mode: number): ServerEntry['kind'] {
  switch (mode & 0o170000) {
    case 0o040000:
      return 'folder';
    case 0o100000:
      return 'file';
    case 0o120000:
      return 'link';
    default:
      return 'other';
  }
}

/** A READDIR name as list() gives it: its kind from the mode the server gave (lstat). */
function entryOf(name: string, attrs: Stats): ServerEntry {
  return {
    name,
    kind: kindOfMode(attrs.mode),
    size: attrs.size,
    mtime: attrs.mtime,
    mode: attrs.mode & 0o7777,
  };
}

function isStatus(error: unknown, code: number): boolean {
  return error instanceof StatusError && error.status === code;
}

/**
 * The TransportError for a failed operation: its code, and the facts report words (the
 * operation, the path, the server's own words); other errors (a local file) pass through.
 */
function failure(error: unknown, operation: TransportOperation, path: ServerPath): unknown {
  if (!(error instanceof StatusError)) return error;
  const answer = (code: TransportErrorCode): TransportError =>
    new TransportError(code, 'answer', {
      operation,
      path,
      ...(error.message === '' ? {} : { serverSaid: error.message }),
      cause: error,
    });
  switch (error.status) {
    case status.noSuchFile:
      return answer('not-found');
    case status.permissionDenied:
      return answer('permission');
    case status.noSpaceOnFilesystem:
    case status.quotaExceeded:
      return answer('quota');
    case status.noConnection:
    case status.connectionLost:
      return connectionLost(error);
    case status.failure:
      // SFTP v3 has no quota code: servers send a failure with the system's words for it.
      return answer(
        /quota|no space|disk full|space left/i.test(error.message) ? 'quota' : 'protocol',
      );
    default:
      return answer('protocol');
  }
}
