// manifest: what sealup uploaded before (format 2, format 1 still read; decision 0032).
//
// Decision hidden: the manifest format and version, its size limit and validation, where it
// lives on the server (one file per target folder, name derived from the absolute target folder),
// and the temp + rename write; the lock beside it (lock.ts, decisions 0031, 0040): its folder, its note's
// format, when a dead run's lock is taken over.
//
// Interface: encode() / decode() (pure; they live in codec.ts, which the import rules hold to "no
// node: import"), and manifestStore(session, { folder, target }) with read() and write(), and
// the target folder's lock: lock(runner, now) takes it (or says who holds it), seeLock(now) only
// reads it.
//
// Invariants: the manifest is untrusted input (R12): unreadable (the server refuses it, or it is
// not a file), invalid (any key or value formats 1 and 2 do not have, a path outside the target
// folder, a pending name that is not a sealup temp name), about another folder or over the size
// limit reads as `unusable`, and the run stops;
// absent means first deploy. A lost connection or a timeout while reading stays a server
// problem. It is written whole under a random temp name, then renamed over the old one, so a
// reader never sees half a manifest. The manifest folder is never inside the target folder
// (R14; deploy checks it before the store is made).
//
// Must never know: the local disk, the plan rules, ssh2 (it sees only the Session port).

import { createHash, randomBytes } from 'node:crypto';
import {
  type Manifest,
  type ManifestRead,
  type ReadResult,
  type RemotePath,
  type ServerPath,
  type Session,
  TransportError,
  type TransportErrorCode,
} from '../contracts/index.ts';
import { foldersToMake, joinServer, parseRemotePath, tempNameFor } from '../paths/index.ts';
import { decode, encode } from './codec.ts';
import {
  type HeldLock,
  type LockSeen,
  type LockTaken,
  type Runner,
  seeLock,
  takeLock,
} from './lock.ts';

export type { HeldLock, Runner };
export { decode, encode };

/** Reads and writes the manifest of one target folder. */
export interface ManifestStore {
  /** The manifest folder, absolute. */
  readonly folder: ServerPath;
  /**
   * The manifest file's name in its folder: the server check finds its date in that folder's
   * listing (spec #41 decision 26).
   */
  readonly name: RemotePath;
  read(): Promise<ManifestRead>;
  /** Replaces the manifest: written under a temp name, then renamed into place. */
  write(manifest: Manifest): Promise<void>;
  /** The lock folder, absolute: `<manifest name>.lock` beside the manifest (decision 0031). */
  readonly lockPath: ServerPath;
  /**
   * Takes the target folder's lock for this run, or says who holds it; a lock the server has seen
   * nothing of for 10 minutes is claimed. `now`: this machine's clock, ms since 1970 (the note).
   */
  lock(runner: Runner, now: () => number): Promise<LockTaken>;
  /** Reads the lock without taking it (a dry run). */
  seeLock(now: () => number): Promise<LockSeen>;
}

interface StoreLocation {
  /** The manifest folder, absolute (default `.sealup` in the login folder). */
  readonly folder: ServerPath;
  /** The absolute target folder the manifest describes. */
  readonly target: ServerPath;
}

/** R12, R21: a manifest larger than this is refused without being read further. */
const defaultMaxBytes = 50 * 1024 * 1024;

/** Read failures that mean "this manifest cannot be read", not "the server is gone". */
const unreadable: ReadonlySet<TransportErrorCode> = new Set(['permission', 'protocol']);

export function manifestStore(
  session: Session,
  at: StoreLocation,
  options: { readonly maxBytes?: number } = {},
): ManifestStore {
  const name = fileName(at.target);
  const path = joinServer(at.folder, name);
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const lockPath = remoteSibling(at.folder, `${name}.lock`);
  const lockPlace = { session, folder: at.folder, path: lockPath };

  return {
    lockPath,
    lock: (runner, now) => takeLock(lockPlace, runner, now),
    seeLock: (now) => seeLock(lockPlace, now),
    folder: at.folder,
    name,

    async read() {
      let result: ReadResult;
      try {
        result = await session.read(path, maxBytes);
      } catch (error) {
        // The file is there but cannot be read (refused, or not a file): sealup cannot know
        // what it uploaded, so it stops (R12). A lost connection or a timeout stays what it is.
        if (error instanceof TransportError && unreadable.has(error.code)) {
          return { kind: 'unusable', reason: 'unreadable' };
        }
        throw error;
      }
      if (result.kind === 'not-found') return { kind: 'absent' };
      if (result.kind === 'too-large') return { kind: 'unusable', reason: 'too-large' };
      const manifest = decode(result.bytes);
      if (manifest === undefined || manifest.folder !== at.target) {
        return { kind: 'unusable', reason: 'invalid' };
      }
      return { kind: 'found', manifest };
    },

    async write(manifest) {
      for (const folder of foldersToMake(session.loginFolder, at.folder)) {
        await session.mkdir(folder);
      }
      const temp = tempNameFor(path, randomBytes(8).toString('hex'));
      await session.put({ bytes: encode(manifest) }, temp);
      await session.rename(temp, path);
    },
  };
}

/**
 * `<readable slug>-<8 hex of SHA-256>.json`: the slug lets a person find the file of a target
 * folder; the hash keeps two folders with the same slug apart (`/a-b` and `/a/b`).
 */
function fileName(target: ServerPath) {
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const hash = createHash('sha256').update(target).digest('hex').slice(0, 8);
  return remote(`${slug === '' ? 'root' : slug}-${hash}.json`);
}

/** A name in the manifest folder, as an absolute path. */
function remoteSibling(folder: ServerPath, name: string): ServerPath {
  return joinServer(folder, remote(name));
}

function remote(text: string) {
  const parsed = parseRemotePath(text);
  if (!parsed.ok) throw new RangeError(`not a remote path (${parsed.problem}): ${text}`);
  return parsed.path;
}
