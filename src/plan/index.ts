// plan: what a deploy will do (decisions 0005, 0008; R13).
//
// Decision hidden: the diff rules: uploads (new or changed by SHA-256), deletes, folders, their
// order, a file that becomes a folder (or the reverse), and the safety nets that block a plan
// (empty source, a kept file in the way).
//
// Interface: plan(input) with the local tree, the manifest read, the target's mappings and its
// excludes, the empty source folders, the target's `allow` and its files written from a secret
// (each as deploy read it back); returns ordered ops (mkdir, upload, write, delete, rmdir), the
// unchanged count, the bytes to upload, the recorded files kept and
// why, whether this is a first deploy, and `blocked` when nothing of it may be applied.
// emptySourceBlock(emptySources, allow) is the empty-source net alone: deploy stops on it before
// connecting, so the rule has one definition; so is publicWrite(targetFolder, writes), R17's
// public-folder net. sameServerPath(sent) finds two entries that send one server path.
//
// Invariants: deletes = (old manifest, plus the mirror's listing when there is one) ∩ inside the
// target ∩ not excluded ∩ not in the source (R13, decision 0030); a server path is mapped back
// through every mapping that holds it, and it is excluded when any of those local paths is. No
// op outside the root. First deploy deletes nothing but what the mirror listed.
// Planning a just-deployed tree gives an empty plan. Order: mkdirs (parents first), uploads,
// deletes, rmdirs (deepest first: only folders that held a deleted file and hold nothing of the
// source and nothing kept). Ops in each group are in path order, so a plan is the same on every
// machine. A source folder that sends nothing blocks the plan unless the target allows it (R20);
// a local path that is missing always blocks it. A file written from a secret (owner ruling 8) is written when the server
// lacks it or holds it otherwise, after the uploads; it is never deleted, nor its folder, even
// when an old manifest recorded the path; one the server holds as it is counts as unchanged.
//
// One exception to "deletes after all uploads" (S1): when the build needs a path that a recorded
// file or folder holds as the other kind (a file `a` now a folder `a/`, or the reverse), what
// stands there is removed first, before any mkdir or upload: the recorded file, or the recorded
// files of the folder and then the folder (deepest first). It is a replacement, not a delete: the
// build cannot arrive while it stands. The removals that make way are the ops before the first
// mkdir or upload; execute drops their records only once all of them ran, so a stopped run's
// rerun repeats them. When what stands there may not be removed (a kept, excluded file), the plan
// is blocked (`in-the-way`) and nothing runs. What the manifest does not show (a file or folder
// made by hand) only the server can find: execute stops on it.
//
// Must never know: the disk, the server, the clock. Pure: no node: import.
//
// The server check (spec #41 decision 26), when the input carries one: a recorded file the build
// still has with the same SHA-256 is uploaded again (`changed-on-server`) when the server lacks
// it, holds it with another size, or dates it after the manifest file; the folders of a missing
// one are made again (a no-op where they stand).
//
// Status (tickets 06, 10): mkdirs, uploads, deletes, rmdirs, excludes, the empty-source net.
// Review S1: a file that becomes a folder, or a folder that becomes a file. Plan 05 T15: the
// server check. Plan 05 T10: the links `allow: [symlinks]` skipped in the build pass through as
// `skipped`; recorded paths deploy found to be a server link or behind one (`linked`) are kept
// with reason `link`, never deleted, and their folders stay. Plan 05 T16 (decision 0030): with
// the full mirror's listing (`mirror`), every listed file not in the build, not recorded and not
// excluded is deleted too (reason `not-in-build`; a recorded one is `left-build`), then every
// listed folder that holds nothing that stays; its links are kept (reason `link`), and what it
// left alone (`held`) keeps its folders, as do the folders the mappings send to. A stray file
// or folder where the build needs the other kind makes way first, as a recorded one does (S1).

import type {
  AllowedRisk,
  ConfigIssue,
  ConfigPlace,
  EmptySource,
  FileRecord,
  KeptFile,
  Mapping,
  Plan,
  PlanBlock,
  PlanInput,
  PlanOp,
  RemotePath,
  SecretFile,
  ServerCheck,
} from '../contracts/index.ts';
import {
  comparePaths,
  excludeMatcher,
  foldersAbove,
  parseRemotePath,
  under,
} from '../paths/index.ts';

export function plan(input: PlanInput): Plan {
  const known: ReadonlyMap<RemotePath, FileRecord> =
    input.remote.kind === 'found' ? input.remote.manifest.files : new Map();
  const uploads: PlanOp[] = [];
  /** Recorded files the server check found missing: their folders may be gone too. */
  const missing: RemotePath[] = [];
  let unchanged = 0;
  let unchangedBytes = 0;
  let bytes = 0;
  for (const [path, file] of [...input.local].sort(([a], [b]) => comparePaths(a, b))) {
    const before = known.get(path);
    let reason: Extract<PlanOp, { op: 'upload' }>['reason'];
    if (before === undefined) reason = 'new';
    else if (before.sha256 !== file.sha256) reason = 'changed';
    else {
      const found = onServer(input.server, path, before);
      if (found === 'same') {
        unchanged++;
        unchangedBytes += file.size;
        continue;
      }
      if (found === 'missing') missing.push(path);
      reason = 'changed-on-server';
    }
    uploads.push({ op: 'upload', path, reason, size: file.size, sha256: file.sha256 });
    bytes += file.size;
  }

  // Files written from a secret (owner ruling 8): written unless the server holds them as they
  // are; never deleted, even when an old manifest recorded the path; their size never counted.
  const writeReads = [...(input.writes ?? [])].sort((a, b) => comparePaths(a.path, b.path));
  const writePaths = new Set(writeReads.map((write) => write.path));
  const writes: PlanOp[] = [];
  for (const { path, from, found } of writeReads) {
    if (found === 'same') unchanged++;
    else writes.push({ op: 'write', path, reason: found === 'absent' ? 'new' : 'changed', from });
  }
  /** What the build puts on the server: uploads, then writes. */
  const placed = [...uploads, ...writes];

  // A folder that holds a recorded file exists already; every other folder of an upload is made.
  // One that holds a file the server check found missing may be gone with it: it is made again
  // (an existing folder makes mkdir a no-op).
  // A folder the mirror listed exists too.
  const { mirror } = input;
  const gone = new Set(missing.flatMap(foldersAbove));
  const existing = new Set([
    ...[...known.keys()].flatMap(foldersAbove).filter((folder) => !gone.has(folder)),
    ...(mirror?.folders ?? []),
  ]);
  const needed = new Set(placed.flatMap((op) => foldersAbove(op.path)));
  const mkdirs: PlanOp[] = [...needed]
    .filter((folder) => !existing.has(folder))
    .sort((a, b) => depth(a) - depth(b) || comparePaths(a, b))
    .map((path) => ({ op: 'mkdir', path }));

  const excluded = excludedOnServer(input.uploads, input.exclude);
  const inBuild = (path: RemotePath): boolean => input.local.has(path) || writePaths.has(path);
  const links = new Set([...(input.linked ?? []), ...(mirror?.links ?? [])]);
  const deletes: RemotePath[] = [];
  const kept: KeptFile[] = [];
  for (const path of [...known.keys()].sort(comparePaths)) {
    // R13 "inside the target": the manifest codec checked every path; checked again here.
    if (inBuild(path) || !parseRemotePath(path).ok) continue;
    if (excluded(path)) kept.push({ path, reason: 'excluded' });
    else if (links.has(path)) kept.push({ path, reason: 'link' });
    else deletes.push(path);
  }
  // The full mirror (decision 0030): what it listed and sealup never recorded.
  const strays = [...(mirror?.files ?? [])].filter((path) => !known.has(path));
  const notInBuild = new Set(strays.filter((path) => !inBuild(path) && !excluded(path)));
  deletes.push(...notInBuild);
  deletes.sort(comparePaths);
  for (const path of mirror?.links ?? []) {
    if (!known.has(path) && !inBuild(path)) kept.push({ path, reason: 'link' });
  }
  kept.sort((a, b) => comparePaths(a.path, b.path));

  const held = [...(mirror?.held ?? [])];
  const staying = new Set([
    ...[...input.local.keys(), ...writePaths, ...kept.map((k) => k.path)].flatMap(foldersAbove),
    ...held,
    ...held.flatMap(foldersAbove),
    // A mirrored run keeps every folder the config sends to, even one the build leaves empty.
    ...(mirror === undefined
      ? []
      : input.uploads.flatMap(({ kind, remote }) =>
          kind === 'folder' && remote !== '' ? [remote, ...foldersAbove(remote)] : [],
        )),
  ]);
  const rmdirs = [...new Set([...deletes.flatMap(foldersAbove), ...(mirror?.folders ?? [])])]
    .filter((folder) => !staying.has(folder))
    .sort((a, b) => depth(b) - depth(a) || comparePaths(a, b));

  // S1: what stands where the build needs the other kind is removed first (header).
  const deleting = new Set(deletes);
  const keptPaths = new Set(kept.map((k) => k.path));
  const makeWay = new Set<RemotePath>();
  const swapped: RemotePath[] = [];
  let inTheWay: PlanBlock | undefined;
  /** The files the server holds, as far as the manifest and the mirror's listing know. */
  const standing = [...known.keys(), ...strays, ...(mirror?.links ?? [])];
  const strayFiles = new Set(strays);
  for (const folder of [...needed].sort(comparePaths)) {
    if (!known.has(folder) && !strayFiles.has(folder)) continue;
    if (deleting.has(folder)) makeWay.add(folder);
    else inTheWay ??= { reason: 'in-the-way', path: folder, found: 'file' };
  }
  for (const upload of placed) {
    if (!existing.has(upload.path)) continue;
    const inside = (path: RemotePath): boolean => path.startsWith(`${upload.path}/`);
    const within = standing.filter(inside);
    // What stays inside it (kept, or left alone by the mirror) keeps the folder there.
    if (
      within.some((path) => keptPaths.has(path)) ||
      held.some((path) => path === upload.path || inside(path))
    ) {
      inTheWay ??= { reason: 'in-the-way', path: upload.path, found: 'folder' };
      continue;
    }
    swapped.push(upload.path);
    for (const path of within) if (deleting.has(path)) makeWay.add(path);
  }
  const emptied = (folder: RemotePath): boolean =>
    swapped.some((path) => folder === path || folder.startsWith(`${path}/`));

  const deleteOp = (path: RemotePath): PlanOp => ({
    op: 'delete',
    path,
    reason: notInBuild.has(path) ? 'not-in-build' : 'left-build',
  });
  const rmdirOp = (path: RemotePath): PlanOp => ({ op: 'rmdir', path });
  const blocked = emptySourceBlock(input.emptySources, input.allow) ?? inTheWay;
  return {
    ops: [
      ...deletes.filter((path) => makeWay.has(path)).map(deleteOp),
      ...rmdirs.filter(emptied).map(rmdirOp),
      ...mkdirs,
      ...placed,
      ...deletes.filter((path) => !makeWay.has(path)).map(deleteOp),
      ...rmdirs.filter((folder) => !emptied(folder)).map(rmdirOp),
    ],
    unchanged,
    unchangedBytes,
    bytes,
    kept,
    skipped: input.skipped ?? [],
    firstDeploy: input.remote.kind === 'absent',
    ...(blocked === undefined ? {} : { blocked }),
  };
}

/**
 * Spec #41 decision 26: how the server holds a recorded file whose SHA-256 the build still has.
 * Changed when it is not there as a file, has another size than recorded, or is dated after the
 * manifest file (both dates from one listing, on the server's clock: a file sealup put is never
 * later than the manifest written after it). Without a server check, the manifest is trusted.
 */
function onServer(
  check: ServerCheck | undefined,
  path: RemotePath,
  record: FileRecord,
): 'same' | 'changed' | 'missing' {
  if (check === undefined) return 'same';
  const listed = check.files.get(path);
  if (listed === undefined) return 'missing';
  if (listed.size !== record.size) return 'changed';
  const { manifestMtime } = check;
  return manifestMtime !== undefined && listed.mtime > manifestMtime ? 'changed' : 'same';
}

/**
 * R20: the first source folder that is missing or would send nothing blocks the run, unless the
 * target allows an empty source: sending nothing would delete every file sealup put there. The
 * allowance is for a folder that exists and is empty: a local path that is not there (a build
 * that failed, a single file removed) always blocks, so no server file of an entry still in the
 * config is deleted because its local side is missing (spec #24 decision 23).
 */
export function emptySourceBlock(
  emptySources: readonly EmptySource[],
  allow: ReadonlySet<AllowedRisk>,
): Extract<PlanBlock, { reason: 'empty-source' }> | undefined {
  const allowed = allow.has('empty-source');
  const source = emptySources.find(({ missing }) => missing || !allowed);
  return source === undefined ? undefined : { reason: 'empty-source', source };
}

/**
 * Folder names a web server commonly serves (R17's public-folder net). A name heuristic: the
 * config has no "web root" key, so a web root under another name is not caught, and a false
 * alarm is fixed with `allowPublic: true` (spec #24 decision 24).
 */
const publicFolders: ReadonlySet<string> = new Set([
  'www',
  'public_html',
  'public',
  'htdocs',
  'httpdocs',
  'html',
  'web',
  'wwwroot',
]);

/**
 * R17: the first file written from a secret (in config order, `allowPublic` ones left out) whose
 * full server path, the target folder in its config form plus the file's path, goes through a
 * folder that looks public, with that folder's name as written, case aside. A net that needs no
 * server: deploy stops on it before connecting (exit 6).
 */
export function publicWrite(
  targetFolder: string,
  writes: readonly SecretFile[],
): { readonly file: SecretFile; readonly folder: string; readonly path: string } | undefined {
  for (const file of writes) {
    if (file.allowPublic) continue;
    const path = under(targetFolder, file.path);
    // Every folder of the path, not the file's own name; `~` is the login folder's marker.
    const folder = path
      .split('/')
      .slice(0, -1)
      .find((name) => publicFolders.has(name.toLowerCase()));
    if (folder !== undefined) return { file, folder, path };
  }
  return undefined;
}

/**
 * Whether a server path (a file, or with `folder` a folder) is excluded: the excludes are written
 * on the local side, so the path goes back through each mapping that holds it to its path from
 * the config folder. The full mirror's listing shares it (decision 0030).
 */
export function excludedOnServer(
  mappings: readonly Mapping[],
  patterns: readonly string[],
): (path: RemotePath, folder?: boolean) => boolean {
  const matches = excludeMatcher(patterns);
  return (path, folder) =>
    mappings.some((mapping) => {
      // A single file holds only its own path (and config refused one an exclude matches).
      const rest =
        mapping.kind === 'file'
          ? path === mapping.remote
            ? ''
            : undefined
          : inside(mapping.remote, path);
      if (rest === undefined) return false;
      return matches(under(mapping.localFromConfig, rest), folder);
    });
}

/** A path an entry of the config sends (an upload's file; T33 adds the write entries). */
export interface SentPath {
  readonly path: RemotePath;
  /** The entry that sends it. */
  readonly place: ConfigPlace;
}

/**
 * Story 43: the first server path two entries send, as a config issue at the later entry naming
 * the earlier one (exit 2, before connecting). Two entries clash on one path, or when one sends
 * a file where the other needs a folder. Paths of one entry never clash with each other.
 */
export function sameServerPath(sent: Iterable<SentPath>): ConfigIssue | undefined {
  const files = new Map<RemotePath, ConfigPlace>();
  const folders = new Map<RemotePath, ConfigPlace>();
  for (const { path, place } of sent) {
    const above = foldersAbove(path);
    const clashes: [RemotePath, ConfigPlace | undefined][] = [
      [path, files.get(path)],
      [path, folders.get(path)],
      ...above.map((folder): [RemotePath, ConfigPlace | undefined] => [folder, files.get(folder)]),
    ];
    for (const [at, other] of clashes) {
      if (other !== undefined && !samePlace(other, place)) {
        return { code: 'same-server-path', ...place, other, path: at };
      }
    }
    if (!files.has(path)) files.set(path, place);
    for (const folder of above) if (!folders.has(folder)) folders.set(folder, place);
  }
  return undefined;
}

function samePlace(a: ConfigPlace, b: ConfigPlace): boolean {
  return a.file === b.file && a.keyPath === b.keyPath;
}

/** `path` relative to `folder` (`''` is the target folder), or undefined when outside it. */
function inside(folder: RemotePath | '', path: RemotePath): string | undefined {
  if (folder === '') return path;
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : undefined;
}

function depth(path: string): number {
  return path.split('/').length;
}
