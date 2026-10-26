// scan: the local side of a deploy.
//
// Decision hidden: walking the source folders, applying excludes, the symlink policy, SHA-256
// hashing with bounded concurrency, and the hash cache (cache.ts) that spares it.
//
// Interface: scanLocal(mappings, exclude, { cache }) returns the LocalTree keyed by RemotePath,
// with size and SHA-256 per file, the source folders that are missing or empty, the symlinks
// found, every path each mapping sends (two may send one path; deploy stops on that), and how
// many files it hashed. Excluded files (.gitignore patterns, matched on the path from the config
// folder) are left out: never hashed, never sent. With a cache, a file whose path, size, mtime
// and ctime match the last scan's keeps its hash unread (spec #41 decision 25).
//
// Invariants: a missing or empty source folder and a symlink are reported, not thrown, so deploy
// can stop on them before connecting (exit 6). A symlink is never followed: it could send files
// from outside the project (spec #1, scan); an excluded one is left out like any excluded path.
// Path-keyed data lives in Maps (R11). A local name that is not a valid remote path (R10)
// throws a LocalNameError: it can never be sent as it is.
//
// Must never know: the server, the manifest, the plan, how output is printed.
//
// Status (tickets 06, 10): excludes, empty and missing folders, symlinks (junctions included).
// Lane C #32: single files (a file mapping sends one file to its own server path; gone is a
// missing source, a link is a symlink), and every path each mapping sends (`sent`). Plan 05 T14:
// the hash cache.

import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  EmptySource,
  LocalFile,
  LocalTree,
  Mapping,
  RemotePath,
  Sha256,
} from '../contracts/index.ts';
import {
  comparePaths,
  excludeMatcher,
  localToRemote,
  type Platform,
  under,
} from '../paths/index.ts';
import {
  type CachedHash,
  type FileStamp,
  type HashCache,
  readHashCache,
  sameStamp,
  writeHashCache,
} from './cache.ts';

export interface ScanResult {
  readonly files: LocalTree;
  /**
   * Source folders that are missing or would send no file (every file excluded counts as
   * empty), in mapping order: deploy's empty-source net (R20) acts on them.
   */
  readonly emptySources: readonly EmptySource[];
  /**
   * Symlinks in the source folders, excluded ones left out: paths from the config folder,
   * `/`-separated, in path order. Deploy stops on them (exit 6).
   */
  readonly symlinks: readonly string[];
  /**
   * Every path a mapping sends, with that mapping, in mapping order; a path two mappings send is
   * listed twice (`files` keeps one). Deploy stops on such a path before connecting.
   */
  readonly sent: readonly { readonly path: RemotePath; readonly mapping: Mapping }[];
  /** How many files were read and hashed: the others' hashes came from the hash cache. */
  readonly hashed: number;
}

export interface ScanOptions {
  /**
   * The project's hash cache (spec #41 decision 25): read at the start, written at the end. None:
   * every file is hashed and nothing is kept.
   */
  readonly cache?: HashCache;
}

/** Files hashed at once: enough to keep a disk busy, few enough to stay far below fd limits. */
const hashing = 16;
/** How long a file's mtime must be past before its hash is kept: FAT's 2 s time step. */
const settling = 2_000;
const platform: Platform = process.platform === 'win32' ? 'win32' : 'posix';

export async function scanLocal(
  mappings: readonly Mapping[],
  exclude: readonly string[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const excluded = excludeMatcher(exclude);
  const found: { path: RemotePath; abs: string; mapping: Mapping }[] = [];
  const emptySources: EmptySource[] = [];
  const symlinks: string[] = [];
  for (const mapping of mappings) {
    const scopedExcluded = excludeMatcher(mapping.exclude ?? []);
    if (mapping.kind === 'file') {
      // config refused a single file an exclude pattern matches: no exclude test here.
      const kind = await entryKind(mapping.local);
      if (kind === 'link') symlinks.push(mapping.localFromConfig);
      else if (kind === 'file' && mapping.remote !== '') {
        found.push({ path: mapping.remote, abs: mapping.local, mapping });
      } else emptySources.push({ mapping, missing: true });
      continue;
    }
    const listed = await listFolder(mapping.local);
    // The excludes are written from the config folder: test each path from there.
    const fromConfig = (abs: string): string => {
      // NFC, as the remote path will be: one name matches the same way on the server side.
      const rel = relative(mapping.local, abs).split(sep).join('/').normalize('NFC');
      return under(mapping.localFromConfig, rel);
    };
    const omitted = (abs: string): boolean =>
      excluded(fromConfig(abs)) ||
      scopedExcluded(relative(mapping.local, abs).split(sep).join('/').normalize('NFC'));
    for (const link of listed?.links ?? []) {
      if (!omitted(link)) symlinks.push(fromConfig(link));
    }
    const files = (listed?.files ?? []).filter((abs) => !omitted(abs));
    // A folder whose every file is excluded would send nothing, like an empty one.
    if (files.length === 0) emptySources.push({ mapping, missing: listed === undefined });
    for (const abs of files) {
      const rel = relative(mapping.local, abs);
      const remote = localToRemote(
        mapping.remote === '' ? rel : `${mapping.remote}/${rel}`,
        platform,
      );
      if (!remote.ok) throw localNameError(mapping, rel, remote.problem);
      found.push({ path: remote.path, abs, mapping });
    }
  }

  const cache = options.cache;
  // A file changed this recently may change again within its file system's time step and keep
  // its stamp (FAT counts mtime in 2 s steps): its hash is used, not kept.
  const settledBefore = BigInt(Date.now() - settling) * 1_000_000n;
  const cached = cache === undefined ? new Map<string, CachedHash>() : await readHashCache(cache);
  const keep = new Map<string, CachedHash>();
  const files = new Map<RemotePath, LocalFile>();
  let hashed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < found.length) {
      const item = found[next++];
      if (item === undefined) return;
      const stamp = cache === undefined ? undefined : await stampOf(item.abs);
      const entry = cached.get(item.abs);
      if (stamp !== undefined && entry !== undefined && sameStamp(entry, stamp)) {
        files.set(item.path, { abs: item.abs, size: Number(entry.size), sha256: entry.sha256 });
        keep.set(item.abs, entry);
        continue;
      }
      const { size, sha256 } = await hashFile(item.abs);
      hashed++;
      files.set(item.path, { abs: item.abs, size, sha256 });
      if (stamp !== undefined && stamp.mtimeNs < settledBefore) {
        keep.set(item.abs, { ...stamp, sha256 });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(hashing, found.length) }, worker));
  if (cache !== undefined) await writeHashCache(cache, keep);
  const sent = found.map(({ path, mapping }) => ({ path, mapping }));
  return { files: sorted(files), emptySources, symlinks: symlinks.sort(), sent, hashed };
}

/** A file's size, mtime and ctime in nanoseconds, as the hash cache keys it (lstat: no link). */
async function stampOf(abs: string): Promise<FileStamp> {
  const stats = await lstat(abs, { bigint: true });
  return { size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

/** What a single file's local side is now, by its own type (lstat: a link is never followed). */
async function entryKind(abs: string): Promise<'file' | 'link' | 'other' | 'missing'> {
  try {
    const stats = await lstat(abs);
    if (stats.isSymbolicLink()) return 'link';
    return stats.isFile() ? 'file' : 'other';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

/**
 * Every file and every symlink below `folder` (absolute paths), or undefined when the folder
 * does not exist. Links are not followed: the walk enters only real folders (the entry's own
 * type, lstat semantics), never a linked one. On Windows a junction counts as a symlink too.
 *
 * The walk is done here, one folder at a time, not with `readdir({ recursive: true })`: from
 * Node 26 that walk enters a linked folder (the link is still listed as a link, but the files
 * behind it are listed too), which would send files from outside the project.
 */
async function listFolder(
  folder: string,
): Promise<{ readonly files: string[]; readonly links: string[] } | undefined> {
  const files: string[] = [];
  const links: string[] = [];
  const walk = async (current: string, entries: readonly Dirent[]): Promise<void> => {
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isSymbolicLink()) links.push(abs);
      else if (entry.isDirectory()) await walk(abs, await readdir(abs, { withFileTypes: true }));
      else if (entry.isFile()) files.push(abs);
    }
  };
  let top: Dirent[];
  try {
    top = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    // Only the source folder itself counts as missing; a folder that vanishes mid-walk throws.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  await walk(folder, top);
  return { files, links };
}

async function hashFile(abs: string): Promise<{ size: number; sha256: Sha256 }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(abs)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest('hex') as Sha256 };
}

/** The same tree in path order, so every later step sees files in one stable order. */
function sorted(files: Map<RemotePath, LocalFile>): LocalTree {
  return new Map([...files].sort(([a], [b]) => comparePaths(a, b)));
}

/** A local file whose name no server path can hold (R10); deploy stops on it (exit 6). */
export class LocalNameError extends Error {
  override readonly name = 'LocalNameError';
  /** The file from the config folder, `/`-separated. */
  readonly path: string;
  readonly reason: 'control-character' | 'backslash' | 'drive-letter' | 'other';

  constructor(path: string, reason: LocalNameError['reason']) {
    super(`cannot send ${path}: not a valid server name (${reason})`);
    this.path = path;
    this.reason = reason;
  }
}

function localNameError(mapping: Mapping, rel: string, problem: string): LocalNameError {
  const slashed = rel.split(sep).join('/');
  const path = under(mapping.localFromConfig, slashed);
  const known = ['control-character', 'backslash', 'drive-letter'] as const;
  const reason = known.find((code) => code === problem) ?? 'other';
  return new LocalNameError(path, reason);
}
