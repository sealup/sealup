// deploy: the use case (decision 0009).
//
// Decision hidden: the order of the steps: choose the target, refuse unsupported keys, scan, the
// safety nets that need no server, start event, connect, the nets that need the login folder,
// take the lock (a dry run only reads it), read the manifest, plan, the server's links (R16),
// stop here on a dry run, execute, release the lock; and which exit code each way of stopping
// gets (decision 0023).
//
// Interface: deploy(request, ports) runs one deploy and returns its Outcome. The request is the
// loaded config and the target name given (if any); the ports are plain parameters: `connect`
// (transport's, or a test server's), `emit` (a reporter's), `signal` (Ctrl-C), `clock` (ms) and
// `cacheFolder` (where the scan keeps its hash cache, if anywhere) and `now` (this machine's
// clock, for the lock's note); the request's `runner` names who runs it.
// stopped(problem, durationMs) is the Outcome of a run that stops on a problem, for callers
// that stop before deploy() (cli: usage and config problems). beforeConnecting(config, name)
// runs the steps before the start event alone, for `check` (spec #24 decision 14): what a
// deploy would stop on before connecting, and the scan. `pull` shares stopped(),
// chooseTarget(config, name), the server identity's line before connecting, after a failed
// connect and once connected (identityBefore, identityAfterFailure, identityAfterConnect: the
// host key, spec #24 decision 26, or the FTPS certificate, spec #41 decision 10),
// keyProblem(error, target), the Problem of a private key transport cannot read (0033), and
// runWarnings(target), what a run to it risks without stopping (plain FTP).
//
// Invariants: every run emits `done` last, with the Outcome it returns. `start` comes first once
// the target is chosen and the nets that need no server passed (ruling 3: a config error, a bad
// local name or a net that stops before connecting prints no target block; a missing host key,
// S16, does). Nothing reaches the server before the safety nets pass, and no credential is sent
// to a server without a pinned host key (R7). A dry run changes nothing. The session is closed
// on every path.
//
// Must never know: argv, the terminal, ssh2 internals, the manifest format, how output is worded.
//
// Status (tickets 04-10): first deploy, redeploy with deletes and excludes, progress events;
// target choice (one target needs no name, several need one, an unknown name gets a
// did-you-mean, a chosen target's config issues stop the run); the manifest folder from
// `manifest:`; the dry run (it stops after the plan event; its Outcome counts what it would
// do); a run that stops part-way keeps what arrived, lists what failed and gives the state
// facts (PartialRun); Ctrl-C through `signal` (exit 130); an error not expected ends the run
// with a state line, never a stack trace; a local name no server path can hold stops before
// connecting (exit 6); the safety nets: manifest folder inside the target (exit 2), symlink and
// empty or missing source (exit 6, before connecting), untrusted manifest (exit 6, before any
// change). Ticket 05: a connect that fails still tells the host key line (changed, verified
// before a refused login, or not checked). Review: a path the build needs held by the other kind
// that sealup may not remove (S1: kept by plan, or found by the server) stops with `in-the-way`,
// exit 6 before any change, 1 after. Lane C #32: two entries sending one server path stop the
// run after the scan, before the nets, as a config problem (exit 2, both lines named). Lane C
// #33: files written from a secret: a write path sent by another entry is that same problem; a
// secret file into a folder that looks public is a net before connecting (exit 6, R17); each
// one is read back before planning (owner ruling 8: no hash kept) and written only when the
// server lacks it or holds it otherwise; `Outcome.written` counts them. Spec #41 decision 26:
// the server check (`checkServer: true`, or the request's `checkServer` for `--check-server`) on
// a redeploy lists the folders that hold tool-owned files (server-check.ts) before planning, so
// plan puts back what changed there; a listing past R21's caps (listingLimits, shared with pull
// and the mirror) stops the run, exit 6, before any change. Plan 05 T06: a private key
// transport cannot read stops the run before dialling, exit 2 (decision 0033).
// Plan 05 T12 (#53): the lock (decision 0031), taken right after login and released on every
// path; held by another run, it stops the run before any change (exit 6, `lock-held`); a lock the
// server has seen nothing of for 10 minutes is claimed (decision 0040, the `lock` event); a dry run
// reads it, never takes it.
// Plan 05 T09 (spec #41 decision 27, R16): once planned, the folders inside the target folder that
// the run writes or deletes in are looked at (links.ts); a link stops the run, exit 6, before any
// change, a dry run too. The lock lives in the manifest folder, which that check never looks at.
// Plan 05 T03: an `ftp://` target has no host key (the `none` host-key event, before
// connecting), its start event carries the plain-FTP warning (runWarnings, shared with pull;
// S23), and a server that cannot set modes gets no `write:` file (exit 6, R17).
// Plan 05 T10 (spec #41 decision 28): `allow: [symlinks]` lets links in the build through the net
// (scan skipped them; the plan lists them as `skipped`), and a delete that would reach a server
// link, or a temp name behind one, is not done: the plan is made again with those files kept
// (reason `link`). A write onto or through a link still stops the run.
// Plan 05 T13 (spec #41 decisions 20-21, S11): a connection lost during the transfer is
// reconnected and the run goes on (resume.ts); `wait` is the port its waits go through.
// Plan 05 T16 (decision 0030): the full mirror (`mirror: true`, or the request's `mirror`) lists
// its folders after the server check, before the plan (mirror.ts); a cap passed or a link
// without the allow stops the run, exit 6; the plan and every re-plan delete what it listed.
// Plan 05 T17 (decision 0029, R20): with the mirror on, a target folder of `/` or `/~` stops the
// run before connecting, one equal to the login folder right after login (exit 6, `risky-folder`),
// unless the target says `allow: [root-folder]`.
// R14 (decision 0038): the manifest folder may sit in the target folder, outside every mapping's
// server folder (manifest-folder.ts).

import { closestTargetName, type ResolvedConfig } from '../config/index.ts';
import {
  type Connect,
  type DeployEvent,
  type EmptySource,
  ExitCode,
  type LockHolder,
  type MirrorListing,
  type Outcome,
  type Plan,
  type PlanBlock,
  type PlanOp,
  type Problem,
  type RunWarning,
  type ServerPath,
  type Session,
  type Target,
  type Timings,
  TransportError,
} from '../contracts/index.ts';
import { type HeldLock, manifestStore, type Runner } from '../manifest/index.ts';

export type { Runner };

import { inCommandSet, joinServer, resolveServerFolder, under } from '../paths/index.ts';
import { emptySourceBlock, publicWrite, sameServerPath } from '../plan/index.ts';
import { LocalNameError, type ScanResult, scanLocal } from '../scan/index.ts';
import { identityAfterConnect, identityAfterFailure, identityBefore } from './identity.ts';
import { linkedPlan, serverLinkCheck } from './links.ts';
import { manifestInsideTarget } from './manifest-folder.ts';
import { listMirrored, riskyFolder } from './mirror.ts';
import { refusedModeProblem, refusedWriteMode } from './modes.ts';

export { mirroredPulls } from './mirror.ts';

import { readBack, replanFrom, transfer, waitFor } from './resume.ts';
import { checkServer, type ListingLimits, listingLimits } from './server-check.ts';

export { identityAfterConnect, identityAfterFailure, identityBefore } from './identity.ts';
export { type ListingLimits, listingLimits } from './server-check.ts';

export interface DeployRequest {
  readonly config: ResolvedConfig;
  /** The target named on the command line, if any. */
  readonly target: string | undefined;
  /** Stop once the plan is known: connect, read the manifest, plan, change nothing. */
  readonly dryRun?: boolean;
  /** Who runs this deploy, for the lock's note (decision 0031). Default: an unknown machine. */
  readonly runner?: Runner;
  /**
   * `--check-server`: run the server check this time, whatever the target's `checkServer` says
   * (spec #41 decision 26).
   */
  readonly checkServer?: boolean;
  /** `--mirror`: mirror every mapping this time (decision 0030). */
  readonly mirror?: boolean;
  /** R21's listing caps; listingLimits unless a test sets lower ones. */
  readonly limits?: ListingLimits;
}

export interface DeployPorts {
  readonly connect: Connect;
  readonly emit: (event: DeployEvent) => void;
  readonly signal: AbortSignal | undefined;
  /** Milliseconds from any fixed point (performance.now in the CLI, fixed in tests). */
  readonly clock: () => number;
  /** This machine's clock, ms since 1970: the lock's note and its age (default Date.now). */
  readonly now?: () => number;
  /**
   * The user's cache folder for sealup (cli finds it in the environment): the scan keeps the
   * project's hash cache there (spec #41 decision 25). None: every file is hashed.
   */
  readonly cacheFolder?: string | undefined;
  /**
   * Waits `ms` before a reconnect try (spec #41 decision 20), resolving early on Ctrl-C
   * (`signal`). Default: a real timer.
   */
  readonly wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

const unknownRunner: Runner = { machine: 'unknown' };

const noTime: Timings = { connect: 0, scan: 0, compare: 0, transfer: 0 };

export async function deploy(request: DeployRequest, ports: DeployPorts): Promise<Outcome> {
  const { clock, emit, signal } = ports;
  const now = ports.now ?? Date.now;
  const started = clock();
  const timings = { ...noTime };
  let doneSent = false;
  /** How many times the run reconnected, once it tried to (spec #41 decision 20). */
  let reconnects: number | undefined;
  const finish = (ended: Outcome): Outcome => {
    doneSent = true;
    const outcome = reconnects === undefined ? ended : { ...ended, reconnects };
    emit({ type: 'done', outcome });
    return outcome;
  };
  const stop = (problem: Problem): Outcome =>
    finish(stopped(problem, clock() - started, { ...timings }));
  /** Runs one phase, adding its time to `timings[phase]`. */
  const timed = async <T>(phase: keyof Timings, work: () => Promise<T>): Promise<T> => {
    const from = clock();
    try {
      return await work();
    } finally {
      timings[phase] = (timings[phase] ?? 0) + clock() - from;
    }
  };
  const interrupted = (): boolean => signal?.aborted === true;
  /** A server problem before any change: Ctrl-C when it was asked for (exit 130). */
  const unchangedBy = (error: TransportError): Outcome =>
    stop(
      interrupted()
        ? { code: 'interrupted', changed: false }
        : { code: 'transport', error, changed: false },
    );

  try {
    return await run();
  } catch (error) {
    // No stack trace without --debug: an error sealup did not expect still ends the run with a
    // state line. Nothing before execute changes the server, and execute catches its own.
    if (doneSent) throw error;
    const unexpected = error instanceof Error ? error : new Error(String(error));
    return stop({ code: 'unexpected', error: unexpected, changed: false });
  }

  async function run(): Promise<Outcome> {
    const before = await beforeConnecting(request.config, request.target, {
      scan: (work) => timed('scan', work),
      cacheFolder: ports.cacheFolder,
      mirror: request.mirror === true,
    });
    if ('problem' in before) return stop(before.problem);
    const { target, scanned } = before;
    const dryRun = request.dryRun === true;
    const { files } = scanned;

    emit({
      type: 'start',
      target,
      configFile: request.config.file,
      dryRun,
      warnings: runWarnings(target),
    });

    const known = identityBefore(target);
    if (known !== undefined) {
      emit({ type: 'host-key', ...known });
      if (known.state === 'missing') {
        return stop({ code: 'host-key-missing', configFile: request.config.file });
      }
    }
    if (interrupted()) return stop({ code: 'interrupted', changed: false });

    let session: Session;
    /** The lock this run holds, once taken: released on every path (decision 0031). */
    let lock: HeldLock | undefined;
    /** Whether the transfer started: before it, nothing changed and the lock leaves no folder. */
    let changing = false;
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
      const checked = identityAfterConnect(session, target);
      if (checked !== undefined) emit({ type: 'host-key', ...checked });
      // FTP (story 16): fewer connections than asked is why a run is slower.
      const pool = (opened: Session): void => {
        const { connections } = opened.caps;
        if (connections !== undefined && connections < target.parallel) {
          emit({ type: 'pool', connections });
        }
      };
      pool(session);
      if (target.server.protocol === 'ssh') {
        // The transport asks for tar only when the login folder may go in a command (R15).
        emit(
          session.archive !== undefined
            ? { type: 'transfer', via: 'archive' }
            : inCommandSet(session.loginFolder)
              ? { type: 'transfer', via: 'file-by-file' }
              : { type: 'transfer', via: 'file-by-file', reason: 'login-folder' },
        );
      }
      // R17 over FTP (spec #41 decision 7): a server that cannot set modes gets no secret file.
      const [unsafe] = session.caps.setMode ? [] : target.writes;
      if (unsafe !== undefined) {
        return stop(refusedModeProblem(target, unsafe));
      }
      const root = serverFolder(target.server.folder, session);
      const manifestFolder = serverFolder(target.manifestFolder, session);
      // Now that the login folder is known, before any change (ruling 9).
      const insideNow = manifestInsideTarget(manifestFolder, root, target, session.loginFolder);
      if (insideNow !== undefined) return stop(insideNow);
      // R20 (decision 0029): a mirrored run into the login folder, known only now.
      const loginFolder = session.loginFolder;
      const risky = riskyFolder(target, request.mirror === true, { root, loginFolder });
      if (risky !== undefined) return stop(risky);
      const store = manifestStore(session, { folder: manifestFolder, target: root });

      /**
       * The lock (decision 0031), before the manifest is read: a plan is only ever made from a
       * manifest no other run is changing. A dry run reads it and never takes it. The problem
       * when another run holds it.
       */
      const takeLock = async (): Promise<Problem | undefined> => {
        if (dryRun) {
          const seen = await store.seeLock(now);
          if (seen.kind === 'held') emit(lockEvent(seen.stale, seen));
          return undefined;
        }
        const taken = await store.lock(request.runner ?? unknownRunner, now);
        if (taken.kind === 'held') {
          const { holder } = taken;
          return {
            code: 'lock-held',
            target: target.name,
            lock: store.lockPath,
            ...(holder === undefined ? {} : { holder }),
          };
        }
        lock = taken.lock;
        const { tookOver } = taken;
        if (tookOver !== undefined) emit(lockEvent(true, 'holder' in tookOver ? tookOver : {}));
        return undefined;
      };

      const checking = request.checkServer === true || target.checkServer;
      // Kept for the run: a folder is looked at once (decision 27).
      const linkCheck = serverLinkCheck(() => session, root, target.parallel);
      /** What the full mirror listed (decision 0030), for the plan and every re-plan. */
      let mirror: MirrorListing | undefined;
      // The lock is part of reading the server's state: its time counts in `compare`.
      const compared = await timed('compare', async () => {
        const held = await takeLock();
        if (held !== undefined) return { held } as const;
        // The note's first write goes out beside the manifest read.
        const [remote] = await Promise.all([store.read(), lock?.ready]);
        if (remote.kind === 'unusable') {
          return { problem: { code: 'manifest-unusable', reason: remote.reason } } as const;
        }
        const writes = await Promise.all(
          target.writes.map((file) => readBack(session, root, file)),
        );
        // Spec #41 decision 26: only a redeploy has tool-owned files to check.
        const server =
          checking && remote.kind === 'found'
            ? await checkServer(session, { root, manifest: store }, remote.manifest.files.keys(), {
                parallel: target.parallel,
                limits: request.limits ?? listingLimits,
              })
            : undefined;
        if (server !== undefined && 'tooLarge' in server) {
          const problem: Problem = {
            code: 'listing-too-large',
            ...server.tooLarge,
            for: 'check-server',
            target: target.name,
          };
          return { problem } as const;
        }
        // Decision 0030: the full mirror lists its folders before the plan, a dry run too.
        const limits = request.limits ?? listingLimits;
        const how = { root, target, limits, linkCheck };
        const listed = await listMirrored(session, request.mirror === true, how);
        if ('problem' in listed) return listed;
        mirror = listed.mirror;
        const input = {
          local: files,
          remote,
          uploads: target.uploads,
          exclude: target.exclude,
          emptySources: scanned.emptySources,
          allow: target.allow,
          writes,
          // Only there when the target allows them: the net stopped the run otherwise.
          skipped: scanned.symlinks,
          ...(server === undefined ? {} : { server }),
          ...(mirror === undefined ? {} : { mirror }),
        };
        // R16 (spec #41 decisions 27-28): with `allow: [symlinks]` a delete that would reach a
        // server link is kept; no write or delete through a link inside the target folder, the
        // last run's temp names included; a plan a net blocks stops on that first.
        const pending = remote.kind === 'found' ? remote.manifest.pending : [];
        const checked = await linkedPlan(input, pending, linkCheck, { target, root });
        if ('problem' in checked) return { problem: checked.problem } as const;
        return { remote, plan: checked.plan, leftovers: checked.leftovers } as const;
      });
      if ('held' in compared) return stop(compared.held);
      if (interrupted()) return stop({ code: 'interrupted', changed: false });
      if ('problem' in compared) return stop(compared.problem);
      const { blocked } = compared.plan;
      if (blocked !== undefined) return stop(blockedProblem(blocked, target, root));
      emit({ type: 'plan', plan: compared.plan });
      if (dryRun) return finish(wouldDo(compared.plan, clock() - started, { ...timings }));
      if (target.server.protocol === 'ftp' || target.server.protocol === 'ftps') {
        const refused = await refusedWriteMode(
          session,
          root,
          compared.plan,
          target.writes,
          store,
          compared.remote.kind === 'found' ? compared.remote.manifest : undefined,
        );
        if (refused !== undefined) {
          return stop(refusedModeProblem(target, refused));
        }
      }

      const found = compared.remote.kind === 'found' ? compared.remote.manifest : undefined;
      const uploads = count(compared.plan, 'upload');
      const transferStarted = clock();
      const replanning = {
        target,
        root,
        local: files,
        emptySources: scanned.emptySources,
        skipped: scanned.symlinks,
        ...(mirror === undefined ? {} : { mirror }),
      };
      changing = true;
      const done = await transfer(compared.plan, {
        context: {
          root,
          local: files,
          writes: new Map(target.writes.map((file) => [file.path, file])),
          parallel: target.parallel,
          // The lock of the session now: a reconnect carries it over (decision 0031).
          ...(lock === undefined ? {} : { heartbeat: async () => lock?.refresh() }),
        },
        session,
        store,
        before: found?.files ?? new Map(),
        leftovers: compared.leftovers,
        signal,
        connect: () => ports.connect(target, { signal }),
        adopt: (next) => {
          session = next;
          pool(next);
          lock = lock?.on(next);
          return manifestStore(next, { folder: manifestFolder, target: root });
        },
        replan: (record, missing, next) =>
          replanFrom(record, missing, next, { ...replanning, linkCheck }),
        onArrived: (files, bytes) => {
          const now = clock();
          emit({
            type: 'progress',
            files,
            totalFiles: uploads,
            bytes,
            totalBytes: compared.plan.bytes,
            elapsedMs: now - started,
            transferMs: now - transferStarted,
          });
        },
        emit,
        wait: (ms) => (ports.wait ?? waitFor)(ms, signal),
        timed: (phase, work) => timed(phase, work),
      });
      if (done.tried) reconnects = done.reconnects;
      if (done.problem !== undefined) return stop(done.problem);
      const counts = {
        uploaded: done.uploaded,
        written: done.written,
        deleted: done.deleted,
        unchanged: compared.plan.unchanged,
        bytes: done.bytes,
      };
      const { changed, run: partial } = done;
      let problem: Problem | undefined;
      // Ctrl-C wins over a failure it caused or raced with: the run was asked to stop (exit 130).
      if (done.interrupted) problem = { code: 'interrupted', changed, run: partial };
      else if (
        done.error instanceof TransportError &&
        done.error.inTheWay !== undefined &&
        done.error.path !== undefined
      ) {
        // Something sealup did not upload stands where the build needs the other kind (S1).
        problem = {
          code: 'in-the-way',
          path: done.error.path,
          found: done.error.inTheWay,
          held: 'not-uploaded',
          changed,
          run: partial,
        };
      } else if (done.error instanceof TransportError) {
        problem = { code: 'transport', error: done.error, changed, run: partial };
      } else if (done.error !== undefined) {
        problem = { code: 'unexpected', error: done.error, changed, run: partial };
      }
      if (problem !== undefined) {
        // What really happened before it stopped (spec "--json object": `failed`).
        return finish({
          ...stopped(problem, clock() - started, { ...timings }),
          ...counts,
          failed: done.failed,
        });
      }
      return finish({
        status: doneStatus(compared.plan),
        exitCode: ExitCode.ok,
        ...counts,
        durationMs: clock() - started,
        timings: { ...timings },
      });
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      return unchangedBy(error);
    } finally {
      await lock?.release({ changedNothing: !changing });
      await session.close();
    }
  }
}

/**
 * The steps of a deploy before its start event, none of which needs the server: choose the
 * target (its config issues stop it), the manifest folder outside the mappings, the scan of the
 * source folders (a local name no server path can hold), two entries sending one server path
 * (the write entries included), then the nets (symlink, empty or missing source, a secret file
 * into a public folder, a mirrored run into `/` or `/~`). A problem is the one the deploy stops
 * on; `scanned` is there once the scan ran. `check` runs these alone (spec #24 decision 14), with
 * the config's `mirror: true` only; `scan` wraps the scan (deploy times it). With `cacheFolder`,
 * the scan reads and keeps the project's hash cache there. `mirror`: `--mirror` (decision 0030).
 */
export async function beforeConnecting(
  config: ResolvedConfig,
  name: string | undefined,
  options: {
    readonly scan?: <T>(work: () => Promise<T>) => Promise<T>;
    readonly cacheFolder?: string | undefined;
    readonly mirror?: boolean;
  } = {},
): Promise<
  | { readonly target: Target; readonly scanned: ScanResult }
  | { readonly problem: Problem; readonly scanned?: ScanResult }
> {
  const chosen = chooseTarget(config, name);
  if ('problem' in chosen) return chosen;
  const target = chosen.target;
  const inside = manifestInsideTarget(target.manifestFolder, target.server.folder, target);
  if (inside !== undefined) return { problem: inside };

  const { scan = (work) => work(), cacheFolder } = options;
  let scanned: ScanResult;
  try {
    const cache =
      cacheFolder === undefined ? {} : { cache: { folder: cacheFolder, project: config.file } };
    scanned = await scan(() => scanLocal(target.uploads, target.exclude, cache));
  } catch (error) {
    if (!(error instanceof LocalNameError)) throw error;
    const { path, reason } = error;
    return { problem: { code: 'bad-local-name', path, reason, target: target.name } };
  }
  // Story 43: two entries sending one server path is a config problem (exit 2), before the nets.
  // The write entries come after the uploads, so the issue lands on the write's line.
  const clash = sameServerPath([
    ...scanned.sent.map(({ path, mapping }) => ({ path, place: mapping.place, entry: mapping })),
    ...target.writes.map((write) => ({ path: write.path, place: write.place, entry: write })),
  ]);
  if (clash !== undefined) {
    return { problem: { code: 'config', issues: [clash], target: target.name }, scanned };
  }
  // R20 (decision 0029) first: the target folder itself, then what the build holds.
  const net = riskyFolder(target, options.mirror === true) ?? safetyNet(target, scanned);
  if (net !== undefined) return { problem: net, scanned };
  return { target, scanned };
}

/** The Outcome of a dry run: what the plan would do, nothing done. */
function wouldDo(planned: Plan, durationMs: number, timings: Timings): Outcome {
  return {
    status: doneStatus(planned),
    exitCode: ExitCode.ok,
    uploaded: count(planned, 'upload'),
    written: count(planned, 'write'),
    deleted: count(planned, 'delete'),
    unchanged: planned.unchanged,
    bytes: planned.bytes,
    durationMs,
    timings,
  };
}

/** `ok`, or `unchanged` when the plan has nothing to do: nothing is sent or written (S09). */
function doneStatus(planned: Plan): 'ok' | 'unchanged' {
  return planned.ops.length === 0 ? 'unchanged' : 'ok';
}

/** How many ops of one kind a plan holds. */
function count(planned: Plan, kind: PlanOp['op']): number {
  return planned.ops.filter((op) => op.op === kind).length;
}

/** The Outcome of a run that stopped on `problem`, with the exit code decision 0023 gives it. */
export function stopped(problem: Problem, durationMs: number, timings: Timings = noTime): Outcome {
  return {
    status: statusOf(problem),
    exitCode: exitCodeOf(problem),
    uploaded: 0,
    written: 0,
    deleted: 0,
    unchanged: 0,
    bytes: 0,
    durationMs,
    timings,
    problem,
  };
}

function statusOf(problem: Problem): Outcome['status'] {
  if (problem.code === 'interrupted' || problem.code === 'cancelled') return 'cancelled';
  // Part of a pull arrived here: what stopped it, or Ctrl-C.
  if (problem.code === 'pull-part-way')
    return problem.error === undefined ? 'cancelled' : 'partial';
  if ('changed' in problem && problem.changed === true) return 'partial';
  return 'failed';
}

function exitCodeOf(problem: Problem): ExitCode {
  switch (problem.code) {
    case 'usage':
    case 'not-available-yet':
    case 'config':
    case 'unknown-target':
    case 'target-not-named':
    case 'manifest-inside-target':
    case 'pull-in-ci':
    case 'no-pull-entries':
    case 'no-terminal':
    case 'config-exists':
    // A key sealup cannot read is the config's value, found before dialling (decision 0033).
    case 'private-key-unreadable':
      return ExitCode.usage;
    case 'host-key-missing':
    case 'host-key-not-replaced':
    case 'certificate-not-replaced':
      return ExitCode.hostKey;
    // A manifest sealup cannot trust stops the run before any change, like the other nets (R12);
    // so does a local name no server path can hold (R10), found before connecting.
    case 'bad-local-name':
    case 'empty-source':
    case 'symlink':
    case 'secret-file-public':
    case 'risky-folder':
    case 'manifest-unusable':
    // Another run holds the target (decision 0031): nothing changed, the same command stops again.
    case 'lock-held':
    case 'pull-unsafe-name':
    case 'pull-local-path':
    case 'pull-too-large':
    case 'listing-too-large':
      return ExitCode.safetyNet;
    // A pull part-way: the files that arrived stay, the same command finishes (decision 11).
    case 'pull-part-way':
      return problem.error === undefined ? ExitCode.interrupted : ExitCode.partial;
    case 'interrupted':
    case 'cancelled':
      return ExitCode.interrupted;
    // A safety net when nothing changed yet; once the server changed, "stopped part-way".
    case 'in-the-way':
      return problem.changed ? ExitCode.partial : ExitCode.safetyNet;
    // Decision 0023 has no code for a bug, so it is 1 even when nothing changed; the state line
    // then says "Nothing was changed", never that a rerun finishes the job (S4).
    case 'unexpected':
      return ExitCode.partial;
    case 'transport':
      // A login refused or another host key (or FTPS certificate, R8) can come after a change
      // only on a reconnect, and stops it at once (spec #41 decision 20): its own code still
      // (I-072, R7).
      if (problem.error.code === 'auth') return ExitCode.auth;
      if (problem.error.code === 'host-key' || problem.error.code === 'tls') {
        return ExitCode.hostKey;
      }
      // "A failure after the first change is 1, not 5" (spec #1).
      if (problem.changed) return ExitCode.partial;
      if (problem.error.code === 'private-key') return ExitCode.usage;
      return ExitCode.unreachable;
  }
}

/**
 * The nets that stop a run before it connects (exit 6): a symlink in a source folder (spec #1),
 * unless the target allows them (`allow: [symlinks]`, spec #41 decision 28: scan never followed
 * them, and the plan lists them as skipped), then a source folder that is missing or would send
 * nothing (R20), unless the target allows it. A folder holding only a link is named as a link.
 */
function safetyNet(target: Target, scanned: ScanResult): Problem | undefined {
  const [link] = scanned.symlinks;
  if (link !== undefined && !target.allow.has('symlinks')) {
    return { code: 'symlink', on: 'source', path: link, target: target.name };
  }
  const block = emptySourceBlock(scanned.emptySources, target.allow);
  if (block !== undefined) return emptySourceProblem(block.source, target);
  // R17: a file written from a secret into a folder that looks public.
  const exposed = publicWrite(target.server.folder, target.writes);
  if (exposed === undefined) return undefined;
  const { file, folder, path } = exposed;
  return { code: 'secret-file-public', path, folder, place: file.place, target: target.name };
}

/** The `lock` event: the holder and its silence when the note says them (decision 0031). */
function lockEvent(
  stale: boolean,
  seen: { readonly holder?: LockHolder; readonly silentMs?: number },
): DeployEvent {
  const { holder, silentMs } = seen;
  return {
    type: 'lock',
    stale,
    ...(holder === undefined ? {} : { holder }),
    ...(silentMs === undefined ? {} : { silentMs }),
  };
}

/** The Problem of a plan a safety net blocks (exit 6, nothing changed). */
function blockedProblem(block: PlanBlock, target: Target, root: ServerPath): Problem {
  if (block.reason === 'empty-source') return emptySourceProblem(block.source, target);
  // A file sealup keeps on purpose (excluded) stands where the build needs the other kind (S1).
  const { path, found } = block;
  return {
    code: 'in-the-way',
    path: joinServer(root, path),
    found,
    held: 'excluded',
    changed: false,
  };
}

function emptySourceProblem(source: EmptySource, target: Target): Problem {
  const { remote, localFromConfig, place } = source.mapping;
  return {
    code: 'empty-source',
    folder: localFromConfig,
    missing: source.missing,
    serverFolder: under(target.server.folder, remote),
    target: target.name,
    place,
  };
}

/**
 * What a run to `target` risks without stopping, on every run (spec #41 decision 11): plain FTP
 * sends the password and the files unencrypted (S23). `pull` shares it.
 */
export function runWarnings(target: Target): RunWarning[] {
  return target.server.protocol === 'ftp' ? [{ code: 'plain-ftp' }] : [];
}

/**
 * The Problem of a connect that stopped on the target's private key (decision 0033): the key
 * cannot be read, so nothing was dialled. Undefined for any other connect failure.
 */
export function keyProblem(error: TransportError, target: Target): Problem | undefined {
  if (error.code !== 'private-key') return undefined;
  const { reason } = error;
  if (reason !== 'passphrase-missing' && reason !== 'passphrase-wrong') {
    return { code: 'private-key-unreadable', reason: 'key-unreadable', target: target.name };
  }
  return { code: 'private-key-unreadable', reason, target: target.name };
}

/**
 * The target of this run: the one named, or the only one. Several and none named stops (no
 * default target, no picker yet); so does a name that is not in the file, with the closest name
 * when one is close. A chosen target with config issues stops with those issues.
 */
export function chooseTarget(
  config: ResolvedConfig,
  name: string | undefined,
): { readonly target: Target } | { readonly problem: Problem } {
  const names = [...config.targets.keys()];
  const configFile = config.file;
  let chosen: string;
  if (name !== undefined) {
    if (!config.targets.has(name)) {
      const suggestion = closestTargetName(name, names);
      return {
        problem: {
          code: 'unknown-target',
          name,
          names,
          configFile,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      };
    }
    chosen = name;
  } else {
    const [only] = names;
    if (names.length !== 1 || only === undefined) {
      return { problem: { code: 'target-not-named', names, configFile } };
    }
    chosen = only;
  }
  const entry = config.targets.get(chosen);
  if (entry === undefined) throw new RangeError(`no target ${chosen}`);
  if (!entry.ok) return { problem: { code: 'config', issues: entry.issues, target: chosen } };
  return { target: entry.target };
}

/** A target or manifest folder as a ServerPath, now that the login folder is known. */
function serverFolder(folder: string, session: Session) {
  const resolved = resolveServerFolder(folder, session.loginFolder);
  // config checked the folder's syntax; this can only fail on a bug.
  if (!resolved.ok) throw new RangeError(`server folder refused (${resolved.problem})`);
  return resolved.path;
}
