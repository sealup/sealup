// The full mirror's listing (decision 0030, spec #41 decision 29): what each mirrored mapping's
// server folder holds, listed a level at a time, `parallel` folders at once, before the plan.
// plan() decides what goes; this only lists.
//
// Nothing is listed below a link, an excluded folder or a name no path can hold (R10, R12: a
// server name is only ever a name). An unexcluded link stops the run unless the target allows
// symlinks; then it is left alone (decision 28). An unexcluded mirrored folder that is a link,
// or sits behind one, counts as a link found there. R21's caps hold (listingLimits): past one,
// nothing more is listed and the run stops before any change. What the listing saw is handed
// to the run's LinkCheck, so the R16 check never looks at it again.

import {
  type Mapping,
  type MirroredPull,
  type MirrorListing,
  type Problem,
  type RemotePath,
  type ServerPath,
  type Session,
  type Target,
  TransportError,
} from '../contracts/index.ts';
import { inPool } from '../execute/index.ts';
import {
  comparePaths,
  depth,
  foldersAbove,
  joinServer,
  parseRemotePath,
  under,
} from '../paths/index.ts';
import { excludedOnServer } from '../plan/index.ts';
import type { LinkCheck } from './links.ts';
import type { ListingLimits, ListingTooLarge } from './server-check.ts';

/**
 * The server folders a run mirrors: each folder mapping's with `mirror: true`, or every one with
 * `--mirror` (`all`); one inside another is listed with it. `''` is the target folder. None: the
 * mirror is off.
 */
function mirroredFolders(uploads: readonly Mapping[], all: boolean): (RemotePath | '')[] {
  const folders = uploads
    .filter((mapping) => mapping.kind === 'folder' && (all || mapping.mirror === true))
    .map((mapping) => mapping.remote);
  const within = (folder: string, outer: string): boolean =>
    outer === '' || folder.startsWith(`${outer}/`);
  return [...new Set(folders)]
    .filter((folder) => !folders.some((outer) => outer !== folder && within(folder, outer)))
    .sort(comparePaths);
}

/**
 * The target's `pull:` folders that its `mirror: true` mappings would delete: inside a mirrored
 * folder, and covered by no `exclude` (ruling 2: `check` points them out), in config order.
 */
export function mirroredPulls(target: Target): MirroredPull[] {
  const excluded = excludedOnServer(target.uploads, target.exclude);
  return target.pulls.flatMap((pull) => {
    const { remote } = pull;
    if (remote === '' || excluded(remote, true)) return [];
    const mapping = target.uploads.find(
      ({ kind, mirror, remote: folder }) =>
        kind === 'folder' && mirror === true && (folder === '' || remote.startsWith(`${folder}/`)),
    );
    if (mapping === undefined) return [];
    const rest = mapping.remote === '' ? remote : remote.slice(mapping.remote.length + 1);
    return [{ pull, exclude: under(mapping.localFromConfig, rest) }];
  });
}

/**
 * R20 (decision 0029): the Problem of a mirrored run (`all`: `--mirror`) into the server's root or
 * the login folder, unless the target says `allow: [root-folder]`. Before connecting (no
 * `connected`), the config's `/`, `/~` and `/~/`; once logged in, a target folder (`root`) that
 * is `/` or the login folder.
 */
export function riskyFolder(
  target: Target,
  all: boolean,
  connected?: { readonly root: ServerPath; readonly loginFolder: ServerPath },
): Problem | undefined {
  const mirrored = mirroredFolders(target.uploads, all);
  if (target.allow.has('root-folder') || mirrored.length === 0) return undefined;
  const { folder } = target.server;
  const risky =
    connected === undefined
      ? folder === '/' || folder === '/~' || folder === '/~/'
      : connected.root === '/' || connected.root === connected.loginFolder;
  if (!risky) return undefined;
  const mapping = all
    ? undefined
    : target.uploads.find(({ kind, mirror }) => kind === 'folder' && mirror === true);
  const shown = connected?.root ?? folder;
  return {
    code: 'risky-folder',
    folder: shown,
    connected: connected !== undefined,
    ...(mapping === undefined ? {} : { mirror: mapping.place }),
    // What the words name: the mirror deletes in these folders only (decision 0030).
    ...(mirrored.includes('') ? {} : { mirrored: mirrored.map((remote) => under(shown, remote)) }),
    target: target.name,
  };
}

interface Mirroring {
  readonly root: ServerPath;
  readonly target: Target;
  readonly limits: ListingLimits;
  readonly linkCheck: LinkCheck;
}

/**
 * The target's mirrored folders listed (`all`: `--mirror`); none when nothing is mirrored; or the
 * Problem that stops the run: a cap passed (`listing-too-large`), or a link found without
 * `allow: [symlinks]` (`symlink`). Both exit 6, before any change.
 */
export async function listMirrored(
  session: Session,
  all: boolean,
  how: Mirroring,
): Promise<{ readonly mirror?: MirrorListing } | { readonly problem: Problem }> {
  const roots = mirroredFolders(how.target.uploads, all);
  if (roots.length === 0) return {};
  const listed = await listMirror(session, roots, how);
  const target = how.target.name;
  if ('tooLarge' in listed) {
    return { problem: { code: 'listing-too-large', ...listed.tooLarge, for: 'mirror', target } };
  }
  if ('link' in listed) {
    return { problem: { code: 'symlink', on: 'server', path: listed.link, target } };
  }
  return { mirror: listed };
}

/** Lists the mirrored folders; or the cap passed, or the first link found without the allow. */
async function listMirror(
  session: Session,
  roots: readonly (RemotePath | '')[],
  how: Mirroring,
): Promise<MirrorListing | ListingTooLarge | { readonly link: ServerPath }> {
  const { root, limits, linkCheck, target } = how;
  const links = target.allow.has('symlinks');
  const at = (path: RemotePath | ''): ServerPath => (path === '' ? root : joinServer(root, path));
  const excluded = excludedOnServer(target.uploads, target.exclude);
  const listing = {
    files: new Set<RemotePath>(),
    folders: new Set<RemotePath>(),
    links: new Set<RemotePath>(),
    held: new Set<RemotePath>(),
  };
  const hold = (folder: RemotePath | ''): void => {
    if (folder !== '') listing.held.add(folder);
  };
  const stop = (path: RemotePath | '', limit: keyof ListingLimits): ListingTooLarge => ({
    tooLarge: { path: at(path), limit, max: limits[limit] },
  });

  let level: (RemotePath | '')[] = [];
  for (const folder of roots) {
    if (folder === '') level.push(folder);
    // Another mapping may protect this root; planned uploads still get their own link check.
    else if (excluded(folder)) hold(folder);
    else if (depth(folder) > limits.depth) return stop(folder, 'depth');
    // The mirrored folder itself, and the folders above it, may be links (R16).
    else if ((await linkCheck.behind([folder])).has(folder)) {
      if (!links) {
        const link = [...foldersAbove(folder), folder].find((path) => linkCheck.isLink(path));
        return { link: at(link ?? folder) };
      }
    } else if (excluded(folder, true)) hold(folder);
    else level.push(folder);
  }

  let count = 0;
  let tooLarge: ListingTooLarge | undefined;
  const found: RemotePath[] = [];
  while (level.length > 0 && tooLarge === undefined && found.length === 0) {
    const next: RemotePath[] = [];
    await inPool(level, target.parallel, async (folder) => {
      if (tooLarge !== undefined) return;
      const listed = await session.list(at(folder), limits.entries).catch((error: unknown) => {
        // A file where a mirrored folder is: nothing to list; the plan's rules meet it.
        if (error instanceof TransportError && error.inTheWay === 'file') return undefined;
        throw error;
      });
      if (listed === undefined || listed.kind === 'not-found') return;
      if (listed.kind === 'found') count += listed.entries.length;
      if (listed.kind === 'too-many' || count > limits.entries) {
        tooLarge ??= stop(folder, 'entries');
        return;
      }
      for (const entry of listed.entries) {
        // A name is only ever one name (R12); one no path can hold is left alone (R10).
        const name = folder === '' ? entry.name : `${folder}/${entry.name}`;
        const parsed = entry.name.includes('/') ? undefined : parseRemotePath(name);
        if (parsed?.ok !== true) {
          hold(folder);
          continue;
        }
        const path = parsed.path;
        linkCheck.saw(path, entry.kind);
        if (entry.kind === 'other' || excluded(path, entry.kind === 'folder')) hold(folder);
        else if (entry.kind === 'link') {
          if (links) listing.links.add(path);
          else found.push(path);
        } else if (entry.kind === 'file') listing.files.add(path);
        else if (depth(path) > limits.depth) tooLarge ??= stop(path, 'depth');
        else {
          listing.folders.add(path);
          next.push(path);
        }
      }
    });
    level = next;
  }
  if (tooLarge !== undefined) return tooLarge;
  const [link] = found.sort(comparePaths);
  return link === undefined ? listing : { link: at(link) };
}
