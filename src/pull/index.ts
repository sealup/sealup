// pull: the `sealup pull` use case (decision 0002, spec #24 decisions 25 and 26, owner ruling 7).
//
// Decision hidden: the order of the steps: choose the target, its pull entries, start event,
// connect, list the server side recursively (R21's limits; links and special files skipped and
// counted), check every server name (R10 with the Windows rules) and every local path on the way
// (lstat: no link or junction, nothing of the other kind in the way, R19), compare (same size and
// same second: already here), stop here on a dry run, remove the pull's leftover temp files,
// make the missing folders, then download `parallel` at once: each file to a temp name in its
// local folder (created exclusively), renamed over the final name, then dated like the server's.
// Which exit code each way of stopping gets.
//
// Interface: pull(request, ports) runs one pull and returns its Outcome (`downloaded` set). The
// request is the loaded config, the target name given (if any), `dryRun`, and R21's limits
// (pullLimits by default). The ports are deploy's: `connect`, `emit` (PullEvents), `signal`
// (Ctrl-C) and `clock` (ms). comparePull(server, local) is the one rule of "already here".
//
// Invariants: every run emits `done` last. Nothing is written here before every name and every
// local path was checked; nothing is ever written outside the folder of sealup.yml (config keeps
// each local side inside it, and every server name is one name, never a path). A local file is
// never deleted: a file that differs is replaced, through a temp file and a rename (ruling 7).
// The server is never changed. A dry run writes nothing. The session is closed on every path.
//
// Must never know: argv, the terminal, ssh2 internals, how output is worded.

import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ResolvedConfig } from '../config/index.ts';
import {
  ExitCode,
  type Outcome,
  type Problem,
  type PullDownload,
  type PullEvent,
  type PullPlan,
  type RemotePath,
  type ServerPath,
  type Session,
  type Target,
  type Timings,
  TransportError,
} from '../contracts/index.ts';
import type { DeployPorts } from '../deploy/index.ts';
import {
  chooseTarget,
  identityAfterConnect,
  identityAfterFailure,
  identityBefore,
  keyProblem,
  listingLimits,
  runWarnings,
  stopped,
} from '../deploy/index.ts';
import { inPool } from '../execute/index.ts';
import {
  comparePaths,
  foldersAbove,
  joinServer,
  parseRemotePath,
  pullNameProblem,
  resolveServerFolder,
  sealupTemp,
} from '../paths/index.ts';

/** R21: what sealup reads from a server's listing at most. */
export interface PullLimits {
  /** Entries in one folder. */
  readonly entries: number;
  /** Files in all. */
  readonly files: number;
  /** Levels of folders below a pull entry's folder. */
  readonly depth: number;
}

/** Entries and files are pull's own; the depth is deploy's listing cap (spec #41 decision 31). */
export const pullLimits: PullLimits = {
  entries: 100_000,
  files: 1_000_000,
  depth: listingLimits.depth,
};

export interface PullRequest {
  readonly config: ResolvedConfig;
  /** The target named on the command line, if any. */
  readonly target: string | undefined;
  /** `--dry-run`: list and compare, write nothing. */
  readonly dryRun?: boolean;
  /** R21's limits; pullLimits unless a test sets lower ones. */
  readonly limits?: PullLimits;
}

/** Deploy's ports, with pull's own events. */
export interface PullPorts extends Omit<DeployPorts, 'emit'> {
  readonly emit: (event: PullEvent) => void;
}

/** A server file, as listed. */
interface Listed {
  readonly from: ServerPath;
  /** From the folder of sealup.yml, `/`-separated. */
  readonly to: string;
  readonly size: number;
  readonly mtime: number;
}

/** What the server holds for a target's pull entries. */
interface Listing {
  readonly files: Listed[];
  /** The local folders the files go into (the entries' own and every one below), from config. */
  readonly folders: string[];
  links: number;
  special: number;
}

/** How a local file compares with the server's: the one rule of "already here". */
export function comparePull(
  server: { readonly size: number; readonly mtime: number },
  local: { readonly size: number; readonly mtimeMs: number } | undefined,
): 'new' | 'replace' | 'unchanged' {
  if (local === undefined) return 'new';
  const same = local.size === server.size && Math.floor(local.mtimeMs / 1000) === server.mtime;
  return same ? 'unchanged' : 'replace';
}

const noTime: Timings = { connect: 0, scan: 0, compare: 0, transfer: 0 };

export async function pull(request: PullRequest, ports: PullPorts): Promise<Outcome> {
  const { clock, emit, signal } = ports;
  const limits = request.limits ?? pullLimits;
  const folder = dirname(request.config.file);
  const started = clock();
  const timings = { ...noTime };
  let doneSent = false;
  const finish = (outcome: Outcome): Outcome => {
    doneSent = true;
    emit({ type: 'done', outcome });
    return outcome;
  };
  const stop = (problem: Problem): Outcome =>
    finish({ ...stopped(problem, clock() - started, { ...timings }), downloaded: 0 });
  const timed = async <T>(phase: keyof Timings, work: () => Promise<T>): Promise<T> => {
    const from = clock();
    try {
      return await work();
    } finally {
      timings[phase] += clock() - from;
    }
  };
  const interrupted = (): boolean => signal?.aborted === true;
  const unchangedBy = (error: TransportError): Outcome =>
    stop(
      interrupted()
        ? { code: 'interrupted', changed: false }
        : { code: 'transport', error, changed: false },
    );

  try {
    return await run();
  } catch (error) {
    // An error sealup did not expect still ends the run with a state line; the downloads catch
    // their own, so nothing was written here when one reaches this.
    if (doneSent) throw error;
    const unexpected = error instanceof Error ? error : new Error(String(error));
    return stop({ code: 'unexpected', error: unexpected, changed: false });
  }

  async function run(): Promise<Outcome> {
    const chosen = chooseTarget(request.config, request.target);
    if ('problem' in chosen) {
      const { problem } = chosen;
      return stop(problem.code === 'unknown-target' ? { ...problem, command: 'pull' } : problem);
    }
    const { target } = chosen;
    const configFile = request.config.file;
    if (target.pulls.length === 0) {
      return stop({ code: 'no-pull-entries', target: target.name, configFile });
    }
    const dryRun = request.dryRun === true;
    emit({ type: 'start', target, configFile, dryRun, warnings: runWarnings(target) });
    const known = identityBefore(target);
    if (known !== undefined) {
      emit({ type: 'host-key', ...known });
      if (known.state === 'missing') return stop({ code: 'host-key-missing', configFile });
    }
    if (interrupted()) return stop({ code: 'interrupted', changed: false });

    let session: Session;
    try {
      session = await timed('connect', () => ports.connect(target, { signal }));
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      const seen = identityAfterFailure(error, target);
      if (seen !== undefined) emit({ type: 'host-key', ...seen });
      const unreadable = keyProblem(error, target);
      return unreadable === undefined ? unchangedBy(error) : stop(unreadable);
    }
    try {
      const identity = identityAfterConnect(session, target);
      if (identity !== undefined) emit({ type: 'host-key', ...identity });
      const root = targetFolder(target, session);
      const listed = await timed('compare', () => listAll(session, root, target, limits));
      if ('problem' in listed) return stop(listed.problem);
      if (interrupted()) return stop({ code: 'interrupted', changed: false });
      const checked = await timed('scan', () => checkLocal(folder, target, listed));
      if ('problem' in checked) return stop(checked.problem);
      const { plan } = checked;
      emit({ type: 'plan', plan });
      const counts = { unchanged: plan.unchanged, uploaded: 0, written: 0, deleted: 0 };
      if (dryRun) {
        return finish({
          status: plan.downloads.length === 0 ? 'unchanged' : 'ok',
          exitCode: ExitCode.ok,
          ...counts,
          downloaded: plan.downloads.length,
          bytes: plan.bytes,
          durationMs: clock() - started,
          timings: { ...timings },
        });
      }
      if (interrupted()) return stop({ code: 'interrupted', changed: false });

      const transferStarted = clock();
      const done = await timed('transfer', async () => {
        await removeLeftovers(folder, checked.existing);
        for (const made of checked.missing) await mkdir(join(folder, ...made.split('/')));
        return download(session, folder, plan, target.parallel, signal, (arrived) => {
          const now = clock();
          emit({
            type: 'progress',
            files: arrived.files,
            totalFiles: plan.downloads.length,
            bytes: arrived.bytes,
            totalBytes: plan.bytes,
            elapsedMs: now - started,
            transferMs: now - transferStarted,
          });
        });
      });
      const partial = { ...counts, downloaded: done.files, bytes: done.bytes };
      const problem = stoppedBy(done, interrupted(), plan, target);
      if (problem !== undefined) {
        return finish({ ...stopped(problem, clock() - started, { ...timings }), ...partial });
      }
      return finish({
        status: plan.downloads.length === 0 ? 'unchanged' : 'ok',
        exitCode: ExitCode.ok,
        ...partial,
        durationMs: clock() - started,
        timings: { ...timings },
      });
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      return unchangedBy(error);
    } finally {
      await session.close();
    }
  }
}

/** Why the downloads stopped, if they did: Ctrl-C wins over a failure it raced with. */
function stoppedBy(
  done: Downloaded,
  interrupted: boolean,
  plan: PullPlan,
  target: Target,
): Problem | undefined {
  if (done.error === undefined && !interrupted) return undefined;
  if (done.files > 0) {
    return {
      code: 'pull-part-way',
      ...(interrupted || done.error === undefined ? {} : { error: done.error }),
      downloaded: done.files,
      downloads: plan.downloads.length,
      target: target.name,
    };
  }
  if (interrupted) return { code: 'interrupted', changed: false };
  if (done.error instanceof TransportError) {
    return { code: 'transport', error: done.error, changed: false };
  }
  return { code: 'unexpected', error: done.error ?? new Error('stopped'), changed: false };
}

/** The target folder as a ServerPath, now that the login folder is known. */
function targetFolder(target: Target, session: Session): ServerPath {
  const resolved = resolveServerFolder(target.server.folder, session.loginFolder);
  // config checked the folder's syntax; this can only fail on a bug.
  if (!resolved.ok) throw new RangeError(`server folder refused (${resolved.problem})`);
  return resolved.path;
}

/**
 * Lists what each pull entry names on the server: a file, or a folder and everything below it,
 * a level at a time, `parallel` folders at once. Stops on the first name pull may not write
 * here, or the first limit passed (R21: nothing more is read).
 */
async function listAll(
  session: Session,
  root: ServerPath,
  target: Target,
  limits: PullLimits,
): Promise<Listing | { readonly problem: Problem }> {
  const listing: Listing = { files: [], folders: [], links: 0, special: 0 };
  let problem: Problem | undefined;
  const refuse = (found: Problem): void => {
    problem ??= found;
  };
  const tooLarge = (path: ServerPath, limit: 'entries' | 'files' | 'depth'): void =>
    refuse({ code: 'pull-too-large', path, limit, max: limits[limit], target: target.name });

  /** One folder's entries; undefined after a problem. */
  const list = async (path: ServerPath) => {
    const found = await session.list(path, limits.entries);
    if (found.kind === 'not-found') {
      throw new TransportError('not-found', 'answer', { path, operation: 'list' });
    }
    if (found.kind === 'too-many') {
      tooLarge(path, 'entries');
      return undefined;
    }
    return found.entries;
  };

  for (const entry of target.pulls) {
    const from = entry.remote === '' ? root : joinServer(root, entry.remote);
    let kind: 'file' | 'folder' | 'link' | 'other' = 'folder';
    if (entry.remote !== '') {
      const name = basename(entry.remote);
      const parent = parentOf(root, entry.remote);
      const entries = await list(parent);
      if (entries === undefined) break;
      const found = entries.find((candidate) => candidate.name === name);
      if (found === undefined) {
        throw new TransportError('not-found', 'answer', { path: from, operation: 'list' });
      }
      kind = found.kind;
      if (kind === 'file') {
        listing.files.push({
          from,
          to: entry.localFromConfig,
          size: found.size,
          mtime: found.mtime,
        });
      }
    }
    if (kind === 'link') listing.links++;
    if (kind === 'other') listing.special++;
    if (kind !== 'folder') continue;

    listing.folders.push(entry.localFromConfig);
    let level = [{ from, to: entry.localFromConfig }];
    for (let depth = 1; level.length > 0 && problem === undefined; depth++) {
      const next: { from: ServerPath; to: string }[] = [];
      await inPool(level, target.parallel, async (folder) => {
        if (problem !== undefined) return;
        const entries = await list(folder.from);
        if (entries === undefined) return;
        for (const child of entries) {
          const unsafe = pullNameProblem(child.name);
          if (unsafe !== undefined) {
            refuse({
              code: 'pull-unsafe-name',
              path: `${folder.from === '/' ? '' : folder.from}/${child.name}`,
              reason: unsafe,
              target: target.name,
            });
            return;
          }
          // A name that passed pullNameProblem is a RemotePath of one segment.
          const name = parseRemotePath(child.name);
          if (!name.ok) throw new RangeError(`server name refused (${name.problem})`);
          const path = joinServer(folder.from, name.path);
          const to = `${folder.to}/${child.name}`;
          if (child.kind === 'file') {
            if (listing.files.length === limits.files) {
              tooLarge(folder.from, 'files');
              return;
            }
            listing.files.push({ from: path, to, size: child.size, mtime: child.mtime });
          } else if (child.kind === 'folder') {
            if (depth > limits.depth) {
              tooLarge(path, 'depth');
              return;
            }
            next.push({ from: path, to });
            listing.folders.push(to);
          } else if (child.kind === 'link') listing.links++;
          else listing.special++;
        }
      });
      level = next;
    }
    if (problem !== undefined) break;
  }
  return problem === undefined ? listing : { problem };
}

/** The folder a remote path sits in, absolute. */
function parentOf(root: ServerPath, remote: RemotePath): ServerPath {
  const parent = foldersAbove(remote).at(-1);
  return parent === undefined ? root : joinServer(root, parent);
}

/** What the local check found: the plan, and which local folders exist or must be made. */
interface Checked {
  readonly plan: PullPlan;
  /** The pull's own folders that exist (leftover temp files are looked for there). */
  readonly existing: readonly string[];
  /** The folders to make, outermost first, from the folder of sealup.yml. */
  readonly missing: readonly string[];
}

/**
 * Checks every local path the pull goes through or writes, with lstat (R19): a folder on the way
 * must be a real folder (never a link or a junction), a file's place must hold nothing or a
 * regular file. Then compares each file with the server's.
 */
async function checkLocal(
  folder: string,
  target: Target,
  listing: Listing,
): Promise<{ readonly problem: Problem } | Checked> {
  const local = (path: string): string => join(folder, ...path.split('/'));
  const holder = (path: string, stats: Stats, needs: 'file' | 'folder'): Problem => ({
    code: 'pull-local-path',
    path,
    found: stats.isSymbolicLink()
      ? 'link'
      : stats.isDirectory()
        ? 'folder'
        : stats.isFile()
          ? 'file'
          : 'other',
    needs,
    target: target.name,
  });

  // Every folder a file goes into, with the folders on the way from the folder of sealup.yml.
  const needed = new Set<string>();
  const addWithParents = (path: string): void => {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) needed.add(parts.slice(0, i).join('/'));
  };
  for (const path of listing.folders) addWithParents(path);
  for (const file of listing.files) {
    const slash = file.to.lastIndexOf('/');
    if (slash > 0) addWithParents(file.to.slice(0, slash));
  }
  const own = new Set(listing.folders);
  const existing: string[] = [];
  const missing: string[] = [];
  const byDepth = [...needed].sort(
    (a, b) => a.split('/').length - b.split('/').length || comparePaths(a, b),
  );
  for (const path of byDepth) {
    const stats = await lstatOrNothing(local(path));
    if (stats === undefined) missing.push(path);
    else if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return { problem: holder(path, stats, 'folder') };
    } else if (own.has(path)) existing.push(path);
  }

  const missingSet = new Set(missing);
  const downloads: PullDownload[] = [];
  let unchanged = 0;
  let bytes = 0;
  const files = [...listing.files].sort((a, b) => comparePaths(a.to, b.to));
  for (const file of files) {
    const slash = file.to.lastIndexOf('/');
    // In a folder still to make, the file is new: no lstat needed.
    const inMissing = slash > 0 && missingSet.has(file.to.slice(0, slash));
    const stats = inMissing ? undefined : await lstatOrNothing(local(file.to));
    if (stats !== undefined && !stats.isFile()) return { problem: holder(file.to, stats, 'file') };
    const compared = comparePull(file, stats);
    if (compared === 'unchanged') {
      unchanged++;
      continue;
    }
    downloads.push({ ...file, reason: compared });
    bytes += file.size;
  }
  const plan: PullPlan = {
    entries: target.pulls,
    downloads,
    unchanged,
    bytes,
    links: listing.links,
    special: listing.special,
  };
  return { plan, existing, missing };
}

async function lstatOrNothing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** R18 here: a pull's temp files that an earlier pull left in its folders are removed. */
async function removeLeftovers(folder: string, folders: readonly string[]): Promise<void> {
  for (const path of folders) {
    const at = join(folder, ...path.split('/'));
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (entry.isFile() && sealupTemp.test(entry.name)) await rm(join(at, entry.name));
    }
  }
}

interface Downloaded {
  readonly files: number;
  readonly bytes: number;
  /** The first failure; no new download started after it. */
  readonly error?: Error;
}

/**
 * The downloads, `parallel` at once: each to a temp name in its local folder, created
 * exclusively, then renamed over the final name, then dated like the server's file. After the
 * first failure, or Ctrl-C, no new one starts; those in flight finish.
 */
async function download(
  session: Session,
  folder: string,
  plan: PullPlan,
  parallel: number,
  signal: AbortSignal | undefined,
  onArrived: (arrived: { readonly files: number; readonly bytes: number }) => void,
): Promise<Downloaded> {
  let files = 0;
  let bytes = 0;
  let error: Error | undefined;
  await inPool(plan.downloads, parallel, async (file) => {
    if (error !== undefined || signal?.aborted === true) return;
    try {
      await downloadOne(session, join(folder, ...file.to.split('/')), file);
      files++;
      bytes += file.size;
      onArrived({ files, bytes });
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
  });
  return { files, bytes, ...(error === undefined ? {} : { error }) };
}

async function downloadOne(session: Session, final: string, file: PullDownload): Promise<void> {
  // The name is cut (whole characters) so the temp name stays within a file system's 255 bytes.
  const name = Array.from(basename(final)).slice(0, 50).join('');
  const temp = join(dirname(final), `.${name}.sealup-${randomBytes(8).toString('hex')}.tmp`);
  // get() creates the temp file exclusively, and removes it on any failure.
  await session.get(file.from, temp, file.size);
  try {
    await rename(temp, final);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await utimes(final, file.mtime, file.mtime);
}
