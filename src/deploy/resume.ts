// The transfer of a deploy, with its reconnects (spec #41 decisions 20-21, S11).
//
// Decision hidden: when a lost connection is worth a reconnect (connection-lost or a timeout
// during the transfer, never Ctrl-C), how many tries and how long between them (3: 1, 2, then
// 4 s), which failure of a try stops at once (anything but no answer: a refused login is never
// tried again, I-072; another host key or certificate is another server, R7), and how a run goes
// on: it re-plans from its own record (what arrived, what was deleted, the temp names left) and
// sends the rest through a fresh execute over the new session.
//
// Interface: transfer(plan, run) applies the plan as execute does and returns what was done in
// all, with the reconnects; readBack(session, root, file) reads a file written from a secret back
// (owner ruling 8), for the first plan and every re-plan.
//
// Invariants: the first connect is deploy's and is never retried. Each try is a whole new login
// through deploy's Connect, so the host key (or the certificate) is checked again. The tries
// count from 1 again only once a resumed transfer got something done: a server that drops every
// new connection at once stops after 3. The lock goes over to the new session (it is never taken
// again); the old session is closed once a new one is open, so a run that cannot reconnect after
// a timeout still releases its lock and closes over it. `reconnecting` comes before each
// try's wait, `reconnected` once the re-plan is known; neither on a run that never lost its
// connection. After the tries, the run stops on the failure that started them.
//
// Must never know: the config file, ssh2, how output is worded.

import { setTimeout as sleep } from 'node:timers/promises';
import {
  type DeployEvent,
  type FileRecord,
  type LocalTree,
  type Manifest,
  type MirrorListing,
  type Plan,
  type PlanInput,
  type Problem,
  type RemotePath,
  type SecretFile,
  type ServerPath,
  type Session,
  type Target,
  TransportError,
  type TransportErrorCode,
  type WriteRead,
} from '../contracts/index.ts';
import { type ExecuteContext, type Executed, execute } from '../execute/index.ts';
import type { ManifestStore } from '../manifest/index.ts';
import { joinServer } from '../paths/index.ts';
import { sameAsSecret, secretSize } from '../secret/index.ts';
import { type LinkCheck, linkedPlan } from './links.ts';

/** The waits before each try, ms (spec #41 decision 20): a dead server fails in under a minute. */
const reconnectWaits: readonly number[] = [1_000, 2_000, 4_000];

/** A failure of the transfer that a new connection may get past. */
const lostCodes: ReadonlySet<TransportErrorCode> = new Set(['connection-lost', 'timeout']);

/** A try's failure that the next try may get past: no answer. Anything else stops at once. */
const retryCodes: ReadonlySet<TransportErrorCode> = new Set([
  'connection-lost',
  'timeout',
  'unreachable',
]);

/** What a transfer needs: execute's context without what a reconnect renews. */
export interface TransferRun {
  readonly context: Omit<
    ExecuteContext,
    'session' | 'store' | 'before' | 'leftovers' | 'onArrived' | 'signal' | 'resumed'
  >;
  readonly session: Session;
  readonly store: ManifestStore;
  /** The files and pending temp names of the manifest read before planning. */
  readonly before: ReadonlyMap<RemotePath, FileRecord>;
  readonly leftovers: readonly RemotePath[];
  readonly signal: AbortSignal | undefined;
  /** Logs in again (deploy's Connect for the target): the host key is checked again. */
  readonly connect: () => Promise<Session>;
  /** Makes `session` the run's: the lock goes over to it; the store over it. */
  readonly adopt: (session: Session) => ManifestStore;
  /** The plan of what is left, over `session`, from the record (`missing`: never arrived). */
  readonly replan: (
    record: Manifest,
    missing: readonly RemotePath[],
    session: Session,
  ) => Promise<Replanned | Problem>;
  /** Uploads arrived and their bytes, over the whole run. */
  readonly onArrived: (files: number, bytes: number) => void;
  readonly emit: (event: DeployEvent) => void;
  /** Waits `ms` before a try; resolves early on Ctrl-C. */
  readonly wait: (ms: number) => Promise<void>;
  /** Runs one phase of the run, adding its time to the timing. */
  readonly timed: <T>(phase: 'transfer' | 'reconnect', work: () => Promise<T>) => Promise<T>;
}

/** What a transfer did in all, its reconnects, and a problem a reconnect stopped on. */
export interface Transferred extends Executed {
  /** Whether it lost its connection and tried to reconnect. */
  readonly tried: boolean;
  readonly reconnects: number;
  /** A re-plan's own stop (a link found on the server, R16). */
  readonly problem?: Problem;
}

/** Applies `first`; after a lost connection, reconnects and sends what is left. */
export async function transfer(first: Plan, run: TransferRun): Promise<Transferred> {
  const totalFiles = first.ops.filter((op) => op.op === 'upload').length;
  const aborted = (): boolean => run.signal?.aborted === true;
  let current = first;
  let session = run.session;
  let store = run.store;
  let before = run.before;
  let leftovers = run.leftovers;
  let done: Executed | undefined;
  let tried = false;
  let reconnects = 0;
  /** Tries used since the transfer last got something done. */
  let used = 0;
  for (;;) {
    const offset = { files: done?.uploaded ?? 0, bytes: done?.bytes ?? 0 };
    const plan = current;
    const context: ExecuteContext = {
      ...run.context,
      session,
      store,
      before,
      leftovers,
      signal: run.signal,
      ...(done === undefined ? {} : { resumed: true }),
      onArrived: (arrived) =>
        run.onArrived(offset.files + arrived.files, offset.bytes + arrived.bytes),
    };
    const step = await run.timed('transfer', () => execute(plan, context));
    if (step.changed || step.uploaded + step.written + step.deleted > 0) used = 0;
    done = done === undefined ? step : merged(done, step);
    const { error } = step;
    if (step.interrupted || !(error instanceof TransportError) || !lostCodes.has(error.code)) {
      return { ...done, tried, reconnects };
    }
    tried = true;
    const lost = done;
    const missing = step.run.missing.map((file) => file.path);
    const back = await run.timed('reconnect', async (): Promise<Back> => {
      let code = error.code;
      while (used < reconnectWaits.length) {
        const attempt = ++used;
        run.emit({
          type: 'reconnecting',
          attempt,
          attempts: reconnectWaits.length,
          code,
          files: lost.uploaded,
          totalFiles,
        });
        await run.wait(reconnectWaits[attempt - 1] ?? 0);
        if (aborted()) return { interrupted: true };
        let next: Session | undefined;
        try {
          next = await run.connect();
          // The old session is closed only now: after a timeout it may still answer, and a run
          // that cannot reconnect releases its lock over it.
          await session.close().catch(() => {});
          session = next;
          const nextStore = run.adopt(next);
          const replanned = await run.replan(step.record, missing, next);
          if (!('plan' in replanned)) return { problem: replanned };
          const filesLeft = replanned.plan.ops.filter((op) => op.op === 'upload').length;
          run.emit({ type: 'reconnected', attempt, filesLeft });
          return { store: nextStore, ...replanned };
        } catch (caught) {
          if (!(caught instanceof TransportError)) throw caught;
          if (aborted()) return { interrupted: true };
          // A refused login, another key, a server that answers wrongly: never tried again.
          if (!retryCodes.has(caught.code)) return { stop: caught };
          await next?.close().catch(() => {});
          code = caught.code;
        }
      }
      return { gaveUp: true };
    });
    if ('gaveUp' in back) return { ...lost, tried, reconnects };
    if ('interrupted' in back) return { ...lost, interrupted: true, tried, reconnects };
    if ('stop' in back) return { ...lost, error: back.stop, tried, reconnects };
    if ('problem' in back) return { ...lost, problem: back.problem, tried, reconnects };
    reconnects++;
    ({ store } = back);
    current = back.plan;
    before = step.record.files;
    ({ leftovers } = back);
  }
}

/** How a reconnect ended. */
type Back =
  | ({ readonly store: ManifestStore } & Replanned)
  | { readonly gaveUp: true }
  | { readonly interrupted: true }
  | { readonly stop: TransportError }
  | { readonly problem: Problem };

/** Two executes of one run as one: counts added, the state as the last one left it. */
function merged(earlier: Executed, later: Executed): Executed {
  const { run: a } = earlier;
  const { run: b } = later;
  return {
    uploaded: earlier.uploaded + later.uploaded,
    written: earlier.written + later.written,
    deleted: earlier.deleted + later.deleted,
    bytes: earlier.bytes + later.bytes,
    changed: earlier.changed || later.changed,
    interrupted: later.interrupted,
    failed: later.failed,
    run: {
      uploads: a.uploads,
      arrived: a.arrived + b.arrived,
      missing: b.missing,
      refused: b.refused,
      writes: a.writes,
      written: a.written + b.written,
      deletes: a.deletes,
      deleted: a.deleted + b.deleted,
      recorded: b.recorded,
    },
    record: later.record,
    ...(later.error === undefined ? {} : { error: later.error }),
  };
}

/** What a re-plan needs besides the record: the first plan's inputs and the run's link check. */
export interface Replanning {
  readonly target: Target;
  readonly root: ServerPath;
  readonly local: LocalTree;
  readonly emptySources: PlanInput['emptySources'];
  /** The links of the source folders, skipped (`allow: [symlinks]`). */
  readonly skipped: readonly string[];
  /** What the full mirror listed before the transfer (decision 0030); its deletes come again. */
  readonly mirror?: MirrorListing;
  readonly linkCheck: LinkCheck;
}

/**
 * The plan of what is left after a reconnect, from the run's own record: the uploads that never
 * arrived are planned as new (their old records set aside, so a file the server check found
 * changed is sent too), the files written from a secret are read back over the new session, and
 * the folders the plan writes in are looked at for links (R16; folders seen before cost nothing).
 */
export async function replanFrom(
  record: Manifest,
  missing: readonly RemotePath[],
  session: Session,
  inputs: Replanning,
): Promise<Replanned | Problem> {
  const { target, root } = inputs;
  const files = new Map(record.files);
  for (const path of missing) files.delete(path);
  const writes = await Promise.all(target.writes.map((file) => readBack(session, root, file)));
  const input: PlanInput = {
    local: inputs.local,
    remote: { kind: 'found', manifest: { ...record, files } },
    uploads: target.uploads,
    exclude: target.exclude,
    emptySources: inputs.emptySources,
    allow: target.allow,
    writes,
    skipped: inputs.skipped,
    ...(inputs.mirror === undefined ? {} : { mirror: inputs.mirror }),
  };
  const checked = await linkedPlan(input, record.pending, inputs.linkCheck, { target, root });
  if ('problem' in checked) return checked.problem;
  // The first plan was not blocked, and nothing it reads has changed since.
  const { blocked } = checked.plan;
  if (blocked !== undefined) throw new RangeError(`re-plan blocked (${blocked.reason})`);
  return checked;
}

/** A re-plan: what is left to do, and the temp names to remove first. */
export interface Replanned {
  readonly plan: Plan;
  readonly leftovers: readonly RemotePath[];
}

/**
 * What the server holds where a file written from a secret goes (owner ruling 8): read back, at
 * most its size plus one byte, and compared without the secret leaving its module. No hash of
 * it is kept anywhere: this one small read is how an unchanged one is skipped. The same bytes
 * under another mode (a looser one left by sam-sync, or a changed `mode:`) are not the file the
 * config asks for: rewritten (R17, spec #24 decision 24).
 */
export async function readBack(
  session: Session,
  root: ServerPath,
  file: SecretFile,
): Promise<WriteRead> {
  const read = await session.read(joinServer(root, file.path), secretSize(file.secret) + 1);
  const found =
    read.kind === 'not-found'
      ? 'absent'
      : read.kind === 'found' && read.mode === file.mode && sameAsSecret(file.secret, read.bytes)
        ? 'same'
        : 'different';
  return { path: file.path, from: file.secret.envName, found };
}

/** The real wait: `ms`, or less when Ctrl-C comes first. */
export async function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, signal === undefined ? {} : { signal });
  } catch {
    // Ctrl-C: the caller looks at the signal.
  }
}
