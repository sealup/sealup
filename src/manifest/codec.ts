// The manifest format, version 2 (decisions 0007 and 0032): plain JSON, the files as an array so
// no path is ever an object key (R11), then `pending`, the temp names a run may have left. Format
// 1 (no `pending`) is still read; any other format is refused. Decoding treats the bytes as
// untrusted (R12): every field is checked and every path passes the one path rule (R10), so no
// record can point outside the target folder, and a pending name is always a sealup temp name,
// never a file of the site. Pure: no node: import (import rules, pure file).

import type { FileRecord, Manifest, RemotePath, Sha256 } from '../contracts/index.ts';
import { parseRemotePath, parseServerPath, sealupTemp } from '../paths/index.ts';

const sha256Shape = /^[0-9a-f]{64}$/;

export function encode(manifest: Manifest): Uint8Array {
  const files = [...manifest.files].map(([path, record]) => ({
    path,
    size: record.size,
    sha256: record.sha256,
  }));
  const json = JSON.stringify({
    format: manifest.format,
    folder: manifest.folder,
    files,
    pending: manifest.pending,
  });
  return new TextEncoder().encode(`${json}\n`);
}

/** The manifest in `bytes`, or undefined when they are not a valid format 1 or 2 manifest. */
export function decode(bytes: Uint8Array): Manifest | undefined {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  // Format 2 has `pending`; format 1, still read, has not.
  if (!(hasKeys(data, topKeys) || hasKeys(data, formatOneKeys))) return undefined;
  if (data.format !== ('pending' in data ? 2 : 1)) return undefined;
  if (typeof data.folder !== 'string') return undefined;
  const folder = parseServerPath(data.folder);
  if (!folder.ok || !Array.isArray(data.files)) return undefined;

  const files = new Map<RemotePath, FileRecord>();
  for (const item of data.files as unknown[]) {
    if (!hasKeys(item, recordKeys) || typeof item.path !== 'string') return undefined;
    const path = parseRemotePath(item.path);
    const { size, sha256 } = item;
    if (!path.ok || files.has(path.path)) return undefined;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined;
    if (typeof sha256 !== 'string' || !sha256Shape.test(sha256)) return undefined;
    files.set(path.path, { size, sha256: sha256 as Sha256 });
  }
  const pending = data.format === 1 ? [] : tempNames(data.pending);
  if (pending === undefined) return undefined;
  return { format: 2, folder: folder.path, files, pending };
}

/**
 * The pending names, each a path in the target folder whose last segment is a sealup temp name
 * (decision 0032): a name of any other shape could make the next run remove a site's file.
 */
function tempNames(value: unknown): RemotePath[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<RemotePath>();
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') return undefined;
    const path = parseRemotePath(item);
    if (!path.ok || names.has(path.path)) return undefined;
    if (!sealupTemp.test(path.path.slice(path.path.lastIndexOf('/') + 1))) return undefined;
    names.add(path.path);
  }
  return [...names];
}

const formatOneKeys = ['files', 'folder', 'format'];
const topKeys = ['files', 'folder', 'format', 'pending'];
const recordKeys = ['path', 'sha256', 'size'];

/**
 * A plain JSON object with exactly these keys (sorted): an unknown key, `__proto__` included, is
 * refused rather than ignored, so a manifest says nothing sealup does not read.
 */
function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
}
