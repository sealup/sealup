// paths: the one strict path rule (R10, decision 0019).
//
// Decision hidden: what a valid remote path is, and how local paths become remote ones. Used by
// config, scan and manifest alike, so there is one rule, not three.
//
// Interface: parseRemotePath / parseServerPath check a string and brand it, or give a problem
// code; localToRemote / remoteToLocal convert between local (Windows or POSIX, passed in) and
// remote paths; resolveServerFolder turns a server URL's folder (absolute or `/~/…`) into a
// ServerPath against the login folder; inLoginFolder tells whether a folder is in the `/~/`
// form; inCommandSet tells whether a server folder may go in a remote command (R15); under
// joins paths in the config's form; isWithin tells whether one folder is in another; joinServer
// puts a RemotePath inside a ServerPath folder; foldersAbove lists the folders a RemotePath sits
// in; depth counts its segments; tempNameFor gives the temp name an
// upload waits under (R18), tempPathFor the same relative to the target folder (the manifest's
// pending names); foldersToMake lists the folders to create so that a server folder
// exists; comparePaths is the one order of paths (a plan is the same on every machine);
// excludeMatcher turns the `exclude` list (.gitignore patterns, local side) into a test on a
// config-relative path (exclude.ts). The local side (local.ts): normalizePath resolves the `.`
// and `..` of a `/`-separated path (undefined when a relative one climbs out); staysInside tells
// whether a path as `path.relative` gives it stays in its folder; folderInside reads a folder
// inside the current one as a person types it.
//
// Invariants: a RemotePath is relative, `/`-separated, has no `..`, no empty or `.` segment, no
// control character (C0, DEL, C1), no backslash, no drive letter, and is NFC. A ServerPath is
// absolute with the same segment rules (ruling 7). A join never leaves its folder: the result is
// checked again, and a forged RemotePath throws.
//
// Must never know: the disk, the server, the config format. Pure: no node: import.

import type { RemotePath, ServerPath } from '../contracts/index.ts';

export { excludeMatcher } from './exclude.ts';
export { folderInside, normalizePath, staysInside } from './local.ts';
export { pullNameProblem, sealupTemp } from './names.ts';

/** Why a string is not a valid path; stable codes, so callers can word their own message. */
type PathProblem =
  | 'empty'
  | 'absolute'
  | 'relative'
  | 'backslash'
  | 'drive-letter'
  | 'empty-segment'
  | 'dot-segment'
  | 'dot-dot-segment'
  | 'control-character'
  | 'not-nfc';

export type PathResult<P> = { readonly ok: true; readonly path: P } | PathRefusal;
interface PathRefusal {
  readonly ok: false;
  readonly problem: PathProblem;
}

/** C0, DEL and C1 control characters: never in a path (CR/LF would inject protocol lines). */
const controlCharacter = /\p{Cc}/u;
const driveLetter = /^[A-Za-z]:/;

/** The checks shared by relative and absolute paths, on the `/`-separated segments. */
function segmentProblem(segments: readonly string[]): PathProblem | undefined {
  for (const segment of segments) {
    if (segment === '') return 'empty-segment';
    if (segment === '.') return 'dot-segment';
    if (segment === '..') return 'dot-dot-segment';
  }
  return undefined;
}

function textProblem(text: string): PathProblem | undefined {
  if (controlCharacter.test(text)) return 'control-character';
  if (text.includes('\\')) return 'backslash';
  return undefined;
}

/** Checks a string against R10 and brands it, or says why it is refused. */
export function parseRemotePath(text: string): PathResult<RemotePath> {
  if (text === '') return refuse('empty');
  const problem =
    textProblem(text) ??
    (text.startsWith('/') ? 'absolute' : undefined) ??
    (driveLetter.test(text) ? 'drive-letter' : undefined) ??
    segmentProblem(text.split('/')) ??
    (text.normalize('NFC') === text ? undefined : 'not-nfc');
  return problem === undefined ? { ok: true, path: text as RemotePath } : refuse(problem);
}

/** Checks an absolute server path (`/` alone, or `/a/b` with R10 segments) and brands it. */
export function parseServerPath(text: string): PathResult<ServerPath> {
  if (text === '') return refuse('empty');
  if (!text.startsWith('/')) return refuse(textProblem(text) ?? 'relative');
  if (text === '/') return { ok: true, path: text as ServerPath };
  const problem =
    textProblem(text) ??
    segmentProblem(text.slice(1).split('/')) ??
    (text.normalize('NFC') === text ? undefined : 'not-nfc');
  return problem === undefined ? { ok: true, path: text as ServerPath } : refuse(problem);
}

/**
 * The folder of a server URL as a ServerPath (spec #1, "Server folder and login folder"): an
 * absolute folder stays as it is; `/~` and `/~/…` are relative to the login folder, as in the
 * SFTP URI convention. `/~user/…` is an ordinary absolute folder.
 */
export function resolveServerFolder(
  folder: string,
  loginFolder: ServerPath,
): PathResult<ServerPath> {
  if (folder === '/~' || folder === '/~/') return { ok: true, path: loginFolder };
  if (!inLoginFolder(folder)) return parseServerPath(folder);
  return parseServerPath(below(loginFolder, folder.slice('/~/'.length)));
}

/** Whether a server folder in the config's form is in the login folder: `/~` or `/~/…`. */
export function inLoginFolder(folder: string): boolean {
  return folder === '/~' || folder.startsWith('/~/');
}

/**
 * `rest` under `folder`, both `/`-separated and in the form the config writes them: a path
 * under a source folder as the config folder sees it (what `exclude` patterns are written
 * against; `folder` is `''` for the config folder itself), or a folder under a server folder.
 * Text only: nothing is checked, nothing branded.
 */
export function under(folder: string, rest: string): string {
  if (folder === '') return rest;
  if (rest === '') return folder;
  return `${folder.replace(/\/$/, '')}/${rest}`;
}

/**
 * Whether `folder` is `root` or inside it. Both in one form: absolute (`/home/site`), or both
 * relative to the login folder (`/~`, `/~/…`); a trailing `/` does not count. Segment-wise, so
 * `/home/site2` is not inside `/home/site`.
 */
export function isWithin(folder: string, root: string): boolean {
  const trim = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);
  const inner = trim(folder);
  const outer = trim(root);
  return inner === outer || inner.startsWith(outer === '/' ? '/' : `${outer}/`);
}

/**
 * The ServerPath of `path` inside `root`. The RemotePath is checked again and so is the result
 * (R10: "after joining, the result is checked again"), so a forged path throws instead of
 * escaping the folder.
 */
export function joinServer(root: ServerPath, path: RemotePath): ServerPath {
  const relative = parseRemotePath(path);
  if (!relative.ok) throw new RangeError(`not a valid remote path (${relative.problem})`);
  const joined = parseServerPath(below(root, relative.path));
  if (!joined.ok || !joined.path.startsWith(root === '/' ? '/' : `${root}/`)) {
    throw new RangeError('the joined path leaves its folder');
  }
  return joined.path;
}

/** The folders a remote path sits in, outermost first: `a/b/c.txt` → `a`, `a/b`. */
export function foldersAbove(path: RemotePath): RemotePath[] {
  const checked = parseRemotePath(path);
  if (!checked.ok) throw new RangeError(`not a valid remote path (${checked.problem})`);
  const parts = checked.path.split('/').slice(0, -1);
  // Each is a prefix of a valid path, cut at a `/`: valid too.
  return parts.map((_, i) => parts.slice(0, i + 1).join('/') as RemotePath);
}

/** How many segments a remote path has: `index.html` is 1, `a/b/c.txt` is 3. */
export function depth(path: RemotePath): number {
  return path.split('/').length;
}

/**
 * R15: whether a server folder may go in a remote command (the SSH archive's `tar -C`): only
 * ASCII letters, digits and `/ . _ - + @ , = : ~`, so no shell reads anything into it, quoted or
 * not. The one folder a command ever holds; file names never go in one.
 */
export function inCommandSet(folder: string): boolean {
  return /^[A-Za-z0-9/._+@,=:~-]+$/.test(folder);
}

/** The random part of a temp name: 16 lowercase hex characters (8 random bytes). */
const tempRandom = /^[0-9a-f]{16}$/;

/**
 * R18: the name an upload is written under before it is renamed over `final`:
 * `.<name>.sealup-<random>.tmp` in the same folder. Hidden, so a web server does not list it;
 * in the same folder, so the rename stays on one file system. `random` is the caller's (this
 * module stays pure): 16 lowercase hex characters.
 */
export function tempNameFor(final: ServerPath, random: string): ServerPath {
  const checked = parseServerPath(final);
  if (!checked.ok || checked.path === '/') throw new RangeError('not a file path on the server');
  if (!tempRandom.test(random)) throw new RangeError('the random part is not 16 hex characters');
  const slash = checked.path.lastIndexOf('/');
  const folder = parseServerPath(checked.path.slice(0, slash) || '/');
  const name = parseRemotePath(`.${checked.path.slice(slash + 1)}.sealup-${random}.tmp`);
  if (!folder.ok || !name.ok) throw new RangeError('not a file path on the server');
  return joinServer(folder.path, name.path);
}

/**
 * The same temp name as tempNameFor gives, for a path relative to the target folder: what the
 * manifest's `pending` list holds (decision 0032). `joinServer(root, tempPathFor(path, random))`
 * is `tempNameFor(joinServer(root, path), random)`.
 */
export function tempPathFor(path: RemotePath, random: string): RemotePath {
  const checked = parseRemotePath(path);
  if (!checked.ok) throw new RangeError('not a file path in the target folder');
  if (!tempRandom.test(random)) throw new RangeError('the random part is not 16 hex characters');
  const slash = checked.path.lastIndexOf('/');
  const temp = `${checked.path.slice(0, slash + 1)}.${checked.path.slice(slash + 1)}.sealup-${random}.tmp`;
  const parsed = parseRemotePath(temp);
  if (!parsed.ok) throw new RangeError('not a file path in the target folder');
  return parsed.path;
}

/**
 * The folders to create, outermost first, so that `folder` exists: each level between the login
 * folder and `folder` when it is inside the login folder (sealup's own ground), else `folder`
 * alone (a parent outside the login folder is the host's to create, never sealup's).
 */
export function foldersToMake(loginFolder: ServerPath, folder: ServerPath): ServerPath[] {
  if (folder === loginFolder) return [];
  const prefix = loginFolder === '/' ? '/' : `${loginFolder}/`;
  if (!folder.startsWith(prefix)) return [folder];
  const parts = folder.slice(prefix.length).split('/');
  return parts.map((_, i) => below(loginFolder, parts.slice(0, i + 1).join('/')) as ServerPath);
}

function below(folder: string, relative: string): string {
  return folder === '/' ? `/${relative}` : `${folder}/${relative}`;
}

/**
 * The one order of paths: by UTF-16 code unit, the same on every machine and locale (never
 * localeCompare). For sort(): plans, manifests, lists and file trees all use it.
 */
export function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The local OS flavour; passed in, so this module stays pure and both are testable anywhere. */
export type Platform = 'win32' | 'posix';

/**
 * Turns a path relative to a local source folder (as `path.relative` gives it) into a
 * RemotePath. On Windows both `\` and `/` separate; on POSIX a `\` is part of a name and is
 * refused, since the name could not round-trip. Names are normalised to NFC (macOS writes NFD).
 */
export function localToRemote(relative: string, platform: Platform): PathResult<RemotePath> {
  const slashed = platform === 'win32' ? relative.replaceAll('\\', '/') : relative;
  return parseRemotePath(slashed.normalize('NFC'));
}

/** The relative local form of a RemotePath, with the local OS's separator. */
export function remoteToLocal(path: RemotePath, platform: Platform): string {
  return platform === 'win32' ? path.replaceAll('/', '\\') : path;
}

function refuse(problem: PathProblem): PathRefusal {
  return { ok: false, problem };
}
