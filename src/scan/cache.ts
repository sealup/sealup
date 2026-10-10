// The hash cache (spec #41 decision 25): one file per project in the user's cache folder, mapping
// a file's absolute path, size, mtime and ctime (nanoseconds) to its SHA-256, so a redeploy from
// a laptop skips hashing files that haven't changed since the last run.
//
// Invariants: the cache only ever costs speed. A missing, unreadable, foreign (another format,
// another project) or corrupt file reads as empty; a failed write is dropped. It is written
// through a temp name and a rename, so a run that stops mid-write leaves the old file whole. It
// lives outside the project, and holds only the files the scan hashed (never a `write:` file:
// those come from secrets and are never scanned).

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sha256 } from '../contracts/index.ts';

/** Where one project's cache is: the user's cache folder for sealup, and the config file. */
export interface HashCache {
  /** The user's cache folder for sealup (`…/sealup`), absolute. */
  readonly folder: string;
  /** The project: its config file, absolute. A cache file names it, and is read for it alone. */
  readonly project: string;
}

/** What a file was when it was hashed: its size, mtime and ctime in nanoseconds. */
export interface FileStamp {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface CachedHash extends FileStamp {
  readonly sha256: Sha256;
}

/** The file's first line of defence against reading something else: its kind and version. */
const format = 'sealup hash cache';
const version = 1;
const sha256Shape = /^[0-9a-f]{64}$/;
const digits = /^\d+$/;

/** The project's cache file: its config file's path, hashed, so one name per project. */
function cacheFile(cache: HashCache): string {
  const name = createHash('sha256').update(cache.project).digest('hex').slice(0, 16);
  return join(cache.folder, `${name}.json`);
}

/** The cached hashes by absolute path; empty when the file is missing, unreadable or not ours. */
export async function readHashCache(cache: HashCache): Promise<Map<string, CachedHash>> {
  const entries = new Map<string, CachedHash>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(cacheFile(cache), 'utf8'));
  } catch {
    return entries;
  }
  if (typeof parsed !== 'object' || parsed === null) return entries;
  const { format: kind, version: found, project, files } = parsed as Record<string, unknown>;
  if (kind !== format || found !== version || project !== cache.project) return entries;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return entries;
  for (const [abs, value] of Object.entries(files)) {
    const entry = cachedHash(value);
    if (entry === undefined) return new Map();
    entries.set(abs, entry);
  }
  return entries;
}

/** One entry, `[size, mtimeNs, ctimeNs, sha256]` with the numbers as decimal strings. */
function cachedHash(value: unknown): CachedHash | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const [size, mtimeNs, ctimeNs, sha256] = value as unknown[];
  for (const number of [size, mtimeNs, ctimeNs]) {
    if (typeof number !== 'string' || !digits.test(number)) return undefined;
  }
  if (typeof sha256 !== 'string' || !sha256Shape.test(sha256)) return undefined;
  return {
    size: BigInt(size as string),
    mtimeNs: BigInt(mtimeNs as string),
    ctimeNs: BigInt(ctimeNs as string),
    sha256: sha256 as Sha256,
  };
}

/**
 * Replaces the project's cache with `entries`, through a temp name and a rename. A failure (a
 * read-only folder, a full disk) is dropped: the next run hashes again.
 */
export async function writeHashCache(
  cache: HashCache,
  entries: ReadonlyMap<string, CachedHash>,
): Promise<void> {
  const files: Record<string, readonly string[]> = Object.create(null);
  for (const [abs, entry] of entries) {
    files[abs] = [`${entry.size}`, `${entry.mtimeNs}`, `${entry.ctimeNs}`, entry.sha256];
  }
  const text = JSON.stringify({ format, version, project: cache.project, files });
  const file = cacheFile(cache);
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await mkdir(cache.folder, { recursive: true });
    await writeFile(temp, text);
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Whether a file still is what it was when the cache entry was made. */
export function sameStamp(entry: FileStamp, now: FileStamp): boolean {
  return entry.size === now.size && entry.mtimeNs === now.mtimeNs && entry.ctimeNs === now.ctimeNs;
}
