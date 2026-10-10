// The file tree a test server holds (the memory server and the in-process SFTP server share it),
// and the view a test gets of it: files with sizes and SHA-256, folders, seeding.

import { createHash } from 'node:crypto';
import type { ServerPath, Sha256 } from '../contracts/index.ts';
import { comparePaths, parseServerPath } from '../paths/index.ts';

/** A file on a test server, as a test sees it. */
interface ServerFile {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly sha256: Sha256;
  /** Modification time, whole seconds since 1970. */
  readonly mtime: number;
  /** Permission bits. */
  readonly mode: number;
  /**
   * The permission bits the file had when its first byte was written (R17: a secret file is
   * never readable by others, not even while it is written); undefined while it is empty.
   */
  readonly firstByteMode: number | undefined;
}

/** What every entry carries, as a server's lstat gives it. */
interface Facts {
  /** Modification time, whole seconds since 1970. */
  readonly mtime: number;
  /** Permission bits, without the kind. */
  readonly mode: number;
}

export type Entry =
  | ({ readonly kind: 'folder' } & Facts)
  | ({
      readonly kind: 'file';
      readonly bytes: Uint8Array;
      /** The mode when its first byte was written (ServerFile); absent while it is empty. */
      readonly firstByteMode?: number;
    } & Facts)
  /** A symbolic link: the servers report it, never follow it. */
  | ({ readonly kind: 'link'; readonly target: string } & Facts)
  /** A socket, a device or a pipe. */
  | ({ readonly kind: 'other' } & Facts);

type FileEntry = Extract<Entry, { readonly kind: 'file' }>;

/** What a test can look at and set up on a test server. */
export interface TreeView {
  /** What the server reports for `.` at login; created empty. */
  readonly loginFolder: ServerPath;
  /** Every file on the server, keyed by absolute path, sorted. */
  files(): ReadonlyMap<string, ServerFile>;
  /** Every folder on the server, `/` included, sorted. */
  folders(): readonly string[];
  /**
   * Puts a file on the server before a test (creating its folders), as if a person had: dated
   * now and mode 0o644 unless `facts` says otherwise.
   */
  seedFile(
    path: string,
    content: string | Uint8Array,
    facts?: { readonly mtime?: number; readonly mode?: number },
  ): void;
  /** Puts a symbolic link to `target` on the server (creating its folders). */
  seedLink(path: string, target: string): void;
  /** Puts a socket on the server (creating its folders): neither file, folder nor link. */
  seedOther(path: string): void;
  /** Puts an empty folder on the server (creating its parents), dated now unless `mtime`. */
  seedFolder(path: string, facts?: { readonly mtime?: number }): void;
}

export interface Tree extends TreeView {
  /** Absolute path → entry; `/` always exists. Server code reads and writes it directly. */
  readonly entries: Map<string, Entry>;
}

/** Whole seconds since 1970, now. */
const now = (): number => Math.floor(Date.now() / 1000);

/** A new file, as a server writes it: dated now (or `mtime`), mode 0o644 (umask 022). */
function newFile(bytes: Uint8Array, mtime = now()): FileEntry {
  return { kind: 'file', bytes, mtime, mode: 0o644 };
}

/**
 * A file written over `previous`: dated now, or `mtime` (a server with its own clock); an existing
 * file keeps its mode, as on a server.
 */
export function writtenFile(
  previous: Entry | undefined,
  bytes: Uint8Array,
  mtime = now(),
): FileEntry {
  const file = newFile(bytes, mtime);
  return previous?.kind === 'file' ? { ...file, mode: previous.mode } : file;
}

/** A new folder, as a server makes it: dated now (or `mtime`), mode 0o755 (umask 022). */
export function newFolder(mtime = now()): Entry {
  return { kind: 'folder', mtime, mode: 0o755 };
}

export function createTree(loginFolderText: string): Tree {
  const loginFolder = serverPath(loginFolderText);
  const entries = new Map<string, Entry>([['/', newFolder()]]);
  makeFolders(entries, loginFolder);
  /** Puts `entry` at `path`, creating its folders. */
  const seed = (path: string, entry: Entry): void => {
    const target = serverPath(path);
    makeFolders(entries, parentOf(target));
    entries.set(target, entry);
  };
  return {
    loginFolder,
    entries,
    files() {
      const files = new Map<string, ServerFile>();
      for (const [path, entry] of [...entries].sort(([a], [b]) => comparePaths(a, b))) {
        if (entry.kind === 'file') files.set(path, describeFile(entry));
      }
      return files;
    },
    folders() {
      return [...entries]
        .filter(([, entry]) => entry.kind === 'folder')
        .map(([path]) => path)
        .sort(comparePaths);
    },
    seedFile(path, content, facts = {}) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      seed(path, { ...newFile(Uint8Array.from(bytes)), ...facts });
    },
    seedLink(path, target) {
      seed(path, { kind: 'link', target, mtime: now(), mode: 0o777 });
    },
    seedOther(path) {
      seed(path, { kind: 'other', mtime: now(), mode: 0o755 });
    },
    seedFolder(path, facts = {}) {
      seed(path, newFolder(facts.mtime));
    },
  };
}

/** The folder a path is in (`/` for a top-level name). */
export function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** Whether a folder holds anything. */
export function hasChildren(entries: ReadonlyMap<string, Entry>, folder: string): boolean {
  const inside = folder === '/' ? '/' : `${folder}/`;
  return [...entries.keys()].some((key) => key !== folder && key.startsWith(inside));
}

/** The names and entries directly inside a folder, in no set order. */
export function childrenOf(
  entries: ReadonlyMap<string, Entry>,
  folder: string,
): [name: string, entry: Entry][] {
  const inside = folder === '/' ? '/' : `${folder}/`;
  const children: [string, Entry][] = [];
  for (const [key, entry] of entries) {
    if (key === folder || !key.startsWith(inside)) continue;
    const name = key.slice(inside.length);
    if (!name.includes('/')) children.push([name, entry]);
  }
  return children;
}

function describeFile(entry: Extract<Entry, { kind: 'file' }>): ServerFile {
  const { bytes, mtime, mode, firstByteMode } = entry;
  const sha256 = createHash('sha256').update(bytes).digest('hex') as Sha256;
  return { bytes: Uint8Array.from(bytes), size: bytes.length, sha256, mtime, mode, firstByteMode };
}

/** Creates a folder and its missing parents (server set-up only, not a Session operation). */
function makeFolders(entries: Map<string, Entry>, folder: string): void {
  let current = '';
  for (const segment of folder.split('/').slice(1)) {
    if (segment === '') continue;
    current = `${current}/${segment}`;
    const entry = entries.get(current);
    if (entry?.kind === 'folder') continue;
    if (entry !== undefined) throw new Error(`a ${entry.kind} is in the way: ${current}`);
    entries.set(current, newFolder());
  }
}

function serverPath(text: string): ServerPath {
  const result = parseServerPath(text);
  if (!result.ok) throw new RangeError(`not a ServerPath (${result.problem}): ${text}`);
  return result.path;
}
