// The server check (`--check-server`, `checkServer: true`; spec #41 decision 26): what the server
// holds of the tool-owned files, read from one listing of the folders that hold them, and the
// manifest file's own date from its folder's listing. plan() decides what changed; this only
// lists.
//
// Each folder is listed once, alone (not recursive), `parallel` at once. A folder the server lacks,
// or holds as a file, holds none of its files. Names the server lists are only looked up, never
// used as paths (R12). R21's listing caps hold (listingLimits, shared with pull and the mirror):
// past one, nothing more is listed and the run stops before any change.

import {
  type ListedFile,
  type ListResult,
  type RemotePath,
  type ServerCheck,
  type ServerEntry,
  type ServerPath,
  type Session,
  TransportError,
} from '../contracts/index.ts';
import { inPool } from '../execute/index.ts';
import { comparePaths, foldersAbove, joinServer } from '../paths/index.ts';

/** What sealup reads of a server's listing at most (R21; spec #41 decisions 29 and 31). */
export interface ListingLimits {
  /** Entries listed in all. */
  readonly entries: number;
  /** Levels of folders below the target folder. */
  readonly depth: number;
}

/** R21's listing caps, shared by the server check, the mirror and pull's depth. */
export const listingLimits: ListingLimits = { entries: 200_000, depth: 64 };

/** A listing cap passed: the folder where it was, absolute, and which cap. */
export interface ListingTooLarge {
  readonly tooLarge: {
    readonly path: ServerPath;
    readonly limit: keyof ListingLimits;
    readonly max: number;
  };
}

interface Where {
  /** The target folder. */
  readonly root: ServerPath;
  /** The manifest folder and the manifest file's name in it. */
  readonly manifest: { readonly folder: ServerPath; readonly name: string };
}

/**
 * Lists the folders that hold the recorded files (and the manifest folder) and gives what the
 * server holds of those files and the manifest file's date.
 */
export async function checkServer(
  session: Session,
  where: Where,
  recorded: Iterable<RemotePath>,
  options: { readonly parallel: number; readonly limits: ListingLimits },
): Promise<ServerCheck | ListingTooLarge> {
  const { root, manifest } = where;
  const { limits } = options;
  /** Folder (`''` is the target folder) → the recorded files in it, by name. */
  const byFolder = new Map<RemotePath | '', Map<string, RemotePath>>();
  for (const path of recorded) {
    const folder = foldersAbove(path).at(-1) ?? '';
    const inFolder = byFolder.get(folder) ?? new Map<string, RemotePath>();
    inFolder.set(folder === '' ? path : path.slice(folder.length + 1), path);
    byFolder.set(folder, inFolder);
  }
  const at = (folder: RemotePath | ''): ServerPath =>
    folder === '' ? root : joinServer(root, folder);

  for (const folder of byFolder.keys()) {
    if (folder !== '' && foldersAbove(folder).length + 1 > limits.depth) {
      return { tooLarge: { path: at(folder), limit: 'depth', max: limits.depth } };
    }
  }

  let listed = 0;
  let tooLarge: ListingTooLarge['tooLarge'] | undefined;
  /** One folder's entries (none when the server lacks it); undefined once a cap is passed. */
  const list = async (path: ServerPath): Promise<readonly ServerEntry[] | undefined> => {
    if (tooLarge !== undefined) return undefined;
    let found: ListResult;
    try {
      found = await session.list(path, limits.entries);
    } catch (error) {
      // A file where a tool-owned folder was: its files are missing; the plan makes it again.
      if (error instanceof TransportError && error.inTheWay === 'file') return [];
      throw error;
    }
    if (found.kind === 'not-found') return [];
    if (found.kind === 'found') listed += found.entries.length;
    if (found.kind === 'too-many' || listed > limits.entries) {
      tooLarge ??= { path, limit: 'entries', max: limits.entries };
      return undefined;
    }
    return found.entries;
  };

  const files = new Map<RemotePath, ListedFile>();
  let manifestMtime: number | undefined;
  // The manifest folder, then the others in path order: the same listing order on every run.
  const folders = [...byFolder.keys()].sort(comparePaths).map((folder) => ({ folder }));
  await inPool([{ folder: null }, ...folders], options.parallel, async ({ folder }) => {
    if (folder === null) {
      const entries = await list(manifest.folder);
      const found = entries?.find((entry) => entry.name === manifest.name);
      if (found?.kind === 'file') manifestMtime = found.mtime;
      return;
    }
    const entries = await list(at(folder));
    if (entries === undefined) return;
    const wanted = byFolder.get(folder) ?? new Map<string, RemotePath>();
    for (const entry of entries) {
      const path = wanted.get(entry.name);
      if (path !== undefined && entry.kind === 'file') {
        files.set(path, { size: entry.size, mtime: entry.mtime });
      }
    }
  });
  if (tooLarge !== undefined) return { tooLarge };
  return { files, manifestMtime };
}
