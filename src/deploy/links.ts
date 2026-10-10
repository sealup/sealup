// R16 on the server (spec #41 decision 27): sealup never writes or deletes through a symbolic
// link inside the target folder. Before the first change, each folder below the target folder
// that a planned operation sits in is looked at with Session.stat (lstat), outermost first, once
// per run. A folder found missing is made by this run, so nothing below it is looked at; a link
// stops the run (deploy turns it into the Problem `symlink`, exit 6). The target folder itself and
// the folders above it are the config's choice and are not looked at; neither is the manifest
// folder, which is outside the target folder (R14).
//
// With `allow: [symlinks]` (spec #41 decision 28), server links are left alone and never deleted:
// `behind` finds the paths a delete would reach through a link, or that are a link themselves
// (each such path is looked at too), so deploy keeps them instead of stopping. A write through a
// link still stops the run, whatever `allow:` says.

import type {
  Plan,
  PlanInput,
  Problem,
  RemotePath,
  ServerPath,
  Session,
  StatResult,
  Target,
} from '../contracts/index.ts';
import { inPool } from '../execute/index.ts';
import { comparePaths, depth, foldersAbove, joinServer } from '../paths/index.ts';
import { plan } from '../plan/index.ts';

/**
 * The plan of `input` with the server's links taken into account, and the last run's temp names
 * (`leftovers`) to remove: with `allow: [symlinks]`, a delete that would reach a link (or a temp
 * name behind one) is kept instead (decision 28), and a write onto a link stops the run; then no
 * write or delete through a link inside the target folder (R16, decision 27), whatever `allow:`
 * says. A plan a net blocks is returned as it is. The first plan and every re-plan after a
 * reconnect (decision 20) go through it, with the run's one LinkCheck.
 */
export async function linkedPlan(
  input: PlanInput,
  pending: readonly RemotePath[],
  check: LinkCheck,
  { target, root }: { readonly target: Target; readonly root: ServerPath },
): Promise<
  { readonly plan: Plan; readonly leftovers: readonly RemotePath[] } | { readonly problem: Problem }
> {
  let planned = plan(input);
  let leftovers = pending;
  if (planned.blocked !== undefined) return { plan: planned, leftovers };
  const linkStop = (path: ServerPath) =>
    ({ problem: { code: 'symlink', on: 'server', path, target: target.name } }) as const;
  if (target.allow.has('symlinks')) {
    const deletes = planned.ops.filter((op) => op.op === 'delete').map((op) => op.path);
    const linked = await check.behind([...deletes, ...leftovers]);
    if (linked.size > 0) {
      planned = plan({ ...input, linked });
      leftovers = leftovers.filter((path) => !linked.has(path));
    }
    // A write onto a path found to be a link would replace the link: never.
    const onto = planned.ops.find(
      (op) => op.op !== 'delete' && op.op !== 'rmdir' && check.isLink(op.path),
    );
    if (onto !== undefined) return linkStop(joinServer(root, onto.path));
  }
  // A dry run stops on a link too: the real run would.
  if (planned.blocked === undefined) {
    const link = await check.above([...planned.ops.map((op) => op.path), ...leftovers]);
    if (link !== undefined) return linkStop(link);
  }
  return { plan: planned, leftovers };
}

/**
 * What the run found of the server's links, kept for the run: a later call (a re-plan after a
 * reconnect) looks only at paths not seen yet, and a folder this run made since is no longer
 * missing to it, so nothing below it is looked at either.
 */
export interface LinkCheck {
  /**
   * The first link (outermost, then in path order) among the folders `paths` sit in, or
   * undefined when there is none.
   */
  readonly above: (paths: Iterable<RemotePath>) => Promise<ServerPath | undefined>;
  /**
   * Those of `paths` that are a link or sit in one (`allow: [symlinks]`): the folders above each
   * are looked at as `above` does, then the path itself when they are all real folders.
   */
  readonly behind: (paths: Iterable<RemotePath>) => Promise<ReadonlySet<RemotePath>>;
  /** Whether this run found `path` to be a link. */
  readonly isLink: (path: RemotePath) => boolean;
  /** What a listing found at `path` (a listing is an lstat of each entry): never looked at again. */
  readonly saw: (path: RemotePath, kind: StatResult['kind']) => void;
}

/** `session`: the run's session now (a reconnect brings a new one, spec #41 decision 20). */
export function serverLinkCheck(
  session: () => Session,
  root: ServerPath,
  parallel: number,
): LinkCheck {
  const seen = new Map<RemotePath, StatResult['kind']>();
  /** Below real folders only: a missing one is made by this run, a file in the way is execute's. */
  const reachable = (path: RemotePath): boolean =>
    foldersAbove(path).every((up) => seen.get(up) === 'folder');
  const look = (paths: readonly RemotePath[]): Promise<void> =>
    inPool(
      paths.filter((path) => !seen.has(path)),
      parallel,
      async (path) => {
        seen.set(path, (await session().stat(joinServer(root, path))).kind);
      },
    );
  /**
   * Looks at the folders `paths` sit in, a level at a time, `parallel` at once; with `stopAt`,
   * stops after the first level that holds a link and returns it.
   */
  const folders = async (
    paths: Iterable<RemotePath>,
    stopAt: boolean,
  ): Promise<RemotePath | undefined> => {
    const all = new Set<RemotePath>();
    for (const path of paths) for (const folder of foldersAbove(path)) all.add(folder);
    const byDepth = [...all].sort((a, b) => depth(a) - depth(b) || comparePaths(a, b));
    for (let level = 1; byDepth.some((folder) => depth(folder) === level); level++) {
      const here = byDepth.filter((folder) => depth(folder) === level && reachable(folder));
      await look(here);
      const link = here.find((folder) => seen.get(folder) === 'link');
      if (stopAt && link !== undefined) return link;
    }
    return undefined;
  };
  return {
    above: async (paths) => {
      const link = await folders(paths, true);
      return link === undefined ? undefined : joinServer(root, link);
    },
    behind: async (paths) => {
      const list = [...paths];
      await folders(list, false);
      await look(list.filter(reachable));
      return new Set(
        list.filter((path) =>
          [...foldersAbove(path), path].some((part) => seen.get(part) === 'link'),
        ),
      );
    },
    isLink: (path) => seen.get(path) === 'link',
    saw: (path, kind) => {
      if (!seen.has(path)) seen.set(path, kind);
    },
  };
}
