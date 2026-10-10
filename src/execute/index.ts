// execute: applying a plan to the server.
//
// Decision hidden: temp names and renames (R18), the order of operations, how many run at once,
// stopping on the first failure, cancellation, and the "what really arrived" manifest.
//
// Interface: execute(plan, context) applies the plan through the context's Session and
// ManifestStore and returns what was done: files uploaded and deleted, bytes, whether the server
// changed, each operation that failed, what stopped it (an error, or the signal), and the facts
// of the state line (PartialRun). The caller turns that into an Outcome. `onArrived` hears the
// running totals after each upload that arrived (the progress line). inPool(items, limit, work)
// is the pool the operations run in, `parallel` at once; pull's downloads run in it too.
//
// Invariants: a blocked plan is never applied. The temp names the last run left (`leftovers`,
// the old manifest's pending list) are removed before anything else, best effort; a dry run
// never gets here. The target folder is created next (with its
// parents below the login folder), then the ops run in plan order: a run of uploads (or of
// deletes) `parallel` at once; a run of mkdirs (or of rmdirs) a level at a time, the folders of
// one depth `parallel` at once, outermost level first for mkdirs and deepest first for rmdirs,
// each level once the one before it has finished (a parent is made before its children start,
// and removed only after they all finished). Each upload goes to a random temp
// name in the same folder, then is renamed over the final name. Deletes start only once every
// upload has arrived (decision 0023), except the removals that make way (plan, S1: the ops
// before the first mkdir or upload), whose records are dropped only once all of them ran, so a
// stopped run's rerun repeats them. After the first failure, or once the signal is aborted
// (Ctrl-C), no new operation starts; operations in flight finish. A failed upload's temp file is
// removed when the connection still answers. The manifest (format 2, decision 0032) is written
// every 30 s of transfer (a checkpoint, skipped when nothing changed, never over the final
// write), and last, at the end of every run that changed a record or the temp names left,
// success, failure or Ctrl-C: the old records, plus a record for each file that really arrived,
// minus each file really deleted, and `pending`: the temp names in flight, those a failure left,
// and the leftovers the server kept. A run under 30 s writes it once. Only a real change counts
// as one: an
// operation that found its work done does not (S2). Any error stops the run this way, not only a
// TransportError: an error sealup did not expect still leaves the manifest written.
//
// Must never know: ssh2, the config file, the local disk, how output is printed.
//
// Status (tickets 06, 08): mkdirs, uploads, deletes, rmdirs; `parallel` uploads (or deletes) at
// once (each upload a put, then a rename); stop on the first failure or on the signal, with the
// failed operations and the state facts. Ticket 05 counts SFTP requests in flight. Review: ops
// in plan order, the removals that make way first (S1); only real changes count (S2). Ticket 20:
// mkdirs and rmdirs a level at a time. One at a time, 795 mkdirs took 19 s of a 31 s first
// deploy on OVH. **[V]** spikes/06-channel-measure/README.md, 2026-10-08. Lane C #33: writes,
// a file from a secret put like an upload (temp name, then rename) with its mode set before the
// first byte, after the uploads; never recorded, and an old record of its path dropped. Plan 05
// T11 (#52): checkpoints, the pending temp names, the last run's leftovers removed first. T08
// (#49, 0034): a session that carries the SSH archive sends each run of uploads as one archive,
// under temp names renamed `parallel` at once afterwards (real names into an empty or new target
// folder); a file arrives once renamed, and a failed archive records nothing. T12 (#53):
// `heartbeat` at each 30 s tick, where deploy rewrites the lock's note (decision 0031).
// 0039: a failed archive under real names records each file it left whole (listed at its
// planned size) and removes a part of one, so no file is left that no manifest knows.

import { randomBytes } from 'node:crypto';
import {
  type ArchiveUpload,
  type FailedOp,
  type FileRecord,
  type LocalTree,
  type Manifest,
  type PartialRun,
  type Plan,
  type PlanOp,
  type RemotePath,
  type SecretFile,
  type ServerPath,
  type Session,
  TransportError,
} from '../contracts/index.ts';
import type { ManifestStore } from '../manifest/index.ts';
import {
  comparePaths,
  depth,
  foldersAbove,
  foldersToMake,
  joinServer,
  tempPathFor,
} from '../paths/index.ts';

export interface ExecuteContext {
  readonly session: Session;
  readonly store: ManifestStore;
  /** The absolute target folder. */
  readonly root: ServerPath;
  /** The files of the manifest read before planning (none on a first deploy). */
  readonly before: ReadonlyMap<RemotePath, FileRecord>;
  /**
   * The temp names that manifest lists as left by a run (`pending`, decision 0032): removed
   * before any other operation; one the server will not remove is listed again.
   */
  readonly leftovers: readonly RemotePath[];
  readonly local: LocalTree;
  /**
   * The target's files written from a secret, by path: what a `write` op puts, and paths the
   * manifest never records (owner ruling 8), even one an old manifest did.
   */
  readonly writes: ReadonlyMap<RemotePath, SecretFile>;
  /** Uploads (or deletes) at once. */
  readonly parallel: number;
  /** Ctrl-C: once aborted, no new operation starts. */
  readonly signal: AbortSignal | undefined;
  /** Called after each upload that arrived, with the files and bytes arrived so far. */
  readonly onArrived: (arrived: { readonly files: number; readonly bytes: number }) => void;
  /**
   * Called at each 30 s checkpoint tick, whether or not the manifest is written then: the lock's
   * note is rewritten there (decision 0031). Skipped while the last one is on its way; a failure
   * never stops the run.
   */
  readonly heartbeat?: () => Promise<void>;
  /**
   * The run goes on after a reconnect (spec #41 decision 20): the manifest is written at the end
   * even with nothing left to do, as the last write may have been the one the connection lost.
   */
  readonly resumed?: boolean;
}

export interface Executed {
  readonly uploaded: number;
  /** Files written from a secret that are in place. */
  readonly written: number;
  readonly deleted: number;
  readonly bytes: number;
  /**
   * Whether the run really changed the server: a file put in place, a file or folder removed, a
   * folder made. An operation that found its work done (the folder was there, the file was
   * already gone, the folder was left because it was not empty) is no change.
   */
  readonly changed: boolean;
  /** The first failure; the run stopped after it. A TransportError, or an error not expected. */
  readonly error?: Error;
  /** The signal stopped the run (Ctrl-C). */
  readonly interrupted: boolean;
  /** Each upload or delete that failed (in-flight ones may fail after the first), path order. */
  readonly failed: readonly FailedOp[];
  /** What was done against what was planned: the state line's facts. */
  readonly run: PartialRun;
  /**
   * The manifest as the run left it (the final write's, written or not): what a reconnected
   * run re-plans from (spec #41 decision 20).
   */
  readonly record: Manifest;
}

type Upload = Extract<PlanOp, { op: 'upload' }>;
type Write = Extract<PlanOp, { op: 'write' }>;
type Delete = Extract<PlanOp, { op: 'delete' }>;

export async function execute(plan: Plan, context: ExecuteContext): Promise<Executed> {
  // deploy stops on a blocked plan; reaching here with one is a bug, before any change.
  if (plan.blocked !== undefined) throw new RangeError(`blocked plan (${plan.blocked.reason})`);
  const { session, root, signal } = context;
  const arrived = new Map<RemotePath, FileRecord>();
  const deleted = new Set<RemotePath>();
  const failed: FailedOp[] = [];
  let changed = false;
  let bytes = 0;
  let error: Error | undefined;
  const stopped = (): boolean => error !== undefined || signal?.aborted === true;

  /**
   * Runs one operation unless the run has stopped (`skipped`); `path` is listed when it fails
   * with a server error. `work` resolves to whether it changed the server: a folder that was
   * there, a file already gone or a folder left alone count for nothing (S2).
   */
  const attempt = async (
    work: () => Promise<boolean>,
    path?: RemotePath,
  ): Promise<'done' | 'failed' | 'skipped'> => {
    if (stopped()) return 'skipped';
    try {
      if (await work()) changed = true;
      return 'done';
    } catch (caught) {
      const failure = asError(caught);
      error ??= failure;
      if (path !== undefined && failure instanceof TransportError) {
        failed.push({ path, code: failure.code });
      }
      return 'failed';
    }
  };
  const step = async (work: () => Promise<boolean>, path?: RemotePath): Promise<boolean> =>
    (await attempt(work, path)) === 'done';

  // The removals that make way (S1) are the ops before the first mkdir, upload or write.
  const making = plan.ops.findIndex(
    (op) => op.op === 'mkdir' || op.op === 'upload' || op.op === 'write',
  );
  const makeWay = new Set(
    plan.ops.slice(0, Math.max(making, 0)).flatMap((op) => (op.op === 'delete' ? [op.path] : [])),
  );
  let wayClear = makeWay.size === 0;
  /** The deleted records the manifest drops: the removals that make way once all of them ran. */
  const gone = (): RemotePath[] => [...deleted].filter((path) => wayClear || !makeWay.has(path));
  // A path written from a secret is never recorded: an old record of it is dropped (ruling 8).
  const forgotten = [...context.before.keys()].filter((path) => context.writes.has(path));

  /** The temp names this run may leave on the server, besides the ones in flight. */
  const pending = new Set<RemotePath>();
  /** The temp names of the uploads and writes on their way now (decision 0032). */
  const inFlight = new Set<RemotePath>();
  /** Counts the changes to what the manifest would say: a checkpoint writes only a new one. */
  let version = 0;

  /** The manifest as it stands now: what arrived, what is gone, the temp names left. */
  const snapshot = (): Manifest => {
    const dropped = new Set([...gone(), ...forgotten]);
    const files = new Map(
      [...context.before, ...arrived]
        .filter(([path]) => !dropped.has(path))
        .sort(([a], [b]) => comparePaths(a, b)),
    );
    return {
      format: 2,
      folder: root,
      files,
      pending: [...pending, ...inFlight].sort(comparePaths),
    };
  };

  // Checkpoints (decision 0032): every 30 s of transfer, the manifest as it stands, unless one
  // is still being written or nothing changed since the last. One that fails does not stop the
  // run: the final write is the record.
  let savedVersion = 0;
  let checkpoints = 0;
  let saving: Promise<void> | undefined;
  const checkpoint = (): void => {
    if (saving !== undefined || version === savedVersion) return;
    const at = version;
    saving = context.store
      .write(snapshot())
      .then(
        () => {
          savedVersion = at;
          checkpoints++;
        },
        () => {},
      )
      .finally(() => {
        saving = undefined;
      });
  };
  let beating: Promise<void> | undefined;
  const { heartbeat } = context;
  const beat = (): void => {
    if (heartbeat === undefined || beating !== undefined) return;
    beating = heartbeat()
      .catch(() => {})
      .finally(() => {
        beating = undefined;
      });
  };
  const timer = setInterval(() => {
    checkpoint();
    beat();
  }, checkpointEvery);
  timer.unref();

  let refused = 0;
  let written = 0;
  try {
    // The temp names the last run left: housekeeping, not a change to the site. Never counted,
    // and it never stops the run; a name the server keeps is listed again.
    await inPool(context.leftovers, context.parallel, async (path) => {
      try {
        if (signal?.aborted === true) throw signal.reason;
        await session.remove(joinServer(root, path));
      } catch {
        pending.add(path);
      }
    });
    if (context.leftovers.length > 0) version++;

    // The archive writes real names into an empty or new target folder (0007 §4, 0034): known
    // before the first change, and good for the first archive only.
    let direct =
      session.archive !== undefined &&
      plan.ops.some(isUpload) &&
      (await emptyFolder(session, root));
    if (plan.ops.length > 0) {
      for (const folder of foldersToMake(session.loginFolder, root)) {
        await step(() => session.mkdir(folder));
      }
    }

    /**
     * R18: `put` writes to a random hidden name in the file's folder, listed in flight; then it
     * is renamed over the final name. A temp file a failure leaves is listed as pending.
     */
    const viaTemp = async (
      path: RemotePath,
      put: (temp: ServerPath) => Promise<void>,
    ): Promise<boolean> => {
      const tempPath = tempPathFor(path, randomBytes(8).toString('hex'));
      const temp = joinServer(root, tempPath);
      inFlight.add(tempPath);
      version++;
      try {
        await put(temp);
        await session.rename(temp, joinServer(root, path));
        return true;
      } catch (caught) {
        if (!(await removeTemp(session, temp, caught))) pending.add(tempPath);
        throw caught;
      } finally {
        inFlight.delete(tempPath);
        version++;
      }
    };

    const send = async (upload: Upload): Promise<void> => {
      const result = await attempt(async () => {
        const file = context.local.get(upload.path);
        if (file === undefined) {
          throw new RangeError(`planned upload not in the local tree: ${upload.path}`);
        }
        return viaTemp(upload.path, (temp) => session.put({ file: file.abs }, temp));
      }, upload.path);
      if (result === 'failed') refused++;
      if (result === 'done') {
        landed(upload);
        context.onArrived({ files: arrived.size, bytes });
      }
    };
    /** Records an upload in place under its final name. */
    const landed = (upload: Upload): void => {
      arrived.set(upload.path, { size: upload.size, sha256: upload.sha256 });
      version++;
      bytes += upload.size;
    };
    /**
     * A run of uploads as one archive (0034): each file under a random temp name in its folder,
     * listed in flight (R18), or under its real name into an empty target folder; then the
     * renames, `parallel` at once. A file arrives only once renamed. A failed archive renames
     * nothing and records nothing; its temp names are removed while the server answers, else
     * listed as pending. Progress counts what the archive passed on.
     */
    /**
     * After a failed archive under real names: lists each folder it wrote into, records each
     * file there at its planned size (it arrived whole), removes one of another size (a part).
     * A lost connection or a stall lists nothing: the next plan sends them all again.
     */
    const keepWhole = async (
      sent: readonly { readonly upload: Upload }[],
      caught: unknown,
    ): Promise<void> => {
      if (
        caught instanceof TransportError &&
        ['timeout', 'connection-lost'].includes(caught.code)
      ) {
        return;
      }
      const byFolder = new Map<ServerPath, Upload[]>();
      for (const { upload } of sent) {
        const parent = foldersAbove(upload.path).at(-1);
        const folder = parent === undefined ? root : joinServer(root, parent);
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), upload]);
      }
      // The folder was empty: it holds these files and the folders above them, nothing more.
      const most = sent.length + byFolder.size;
      await inPool([...byFolder], context.parallel, async ([folder, uploads]) => {
        try {
          const listed = await session.list(folder, most);
          if (listed.kind !== 'found') return;
          const held = new Map(listed.entries.map((entry) => [entry.name, entry]));
          for (const upload of uploads) {
            const entry = held.get(upload.path.slice(upload.path.lastIndexOf('/') + 1));
            if (entry?.kind !== 'file') continue;
            if (entry.size === upload.size) landed(upload);
            else await session.remove(joinServer(root, upload.path)).catch(() => {});
          }
        } catch {
          // Not listed: those files stay unrecorded, and the next plan sends them again.
        }
      });
    };
    const sendArchive = async (archive: ArchiveUpload, ups: readonly Upload[]): Promise<void> => {
      if (stopped()) return;
      const realNames = direct;
      direct = false;
      const sent = ups.map((upload) => {
        const file = context.local.get(upload.path);
        if (file === undefined) {
          throw new RangeError(`planned upload not in the local tree: ${upload.path}`);
        }
        const temp = realNames
          ? upload.path
          : tempPathFor(upload.path, randomBytes(8).toString('hex'));
        return { upload, temp, file: { path: temp, file: file.abs, size: upload.size } };
      });
      if (!realNames) {
        for (const item of sent) inFlight.add(item.temp);
        version++;
      }
      /** A temp name no longer on its way: removed, else listed as pending. */
      const settleTemp = async (temp: RemotePath, caught: unknown): Promise<void> => {
        if (!(await removeTemp(session, joinServer(root, temp), caught))) pending.add(temp);
        inFlight.delete(temp);
        version++;
      };
      const result = await attempt(async () => {
        await archive.send(
          root,
          sent.map((item) => item.file),
          { onSent: (progress) => context.onArrived(progress), signal },
        );
        return true;
      });
      if (result !== 'done') {
        // Under real names, `tar` may have put some files in place before it stopped: each one
        // there whole is recorded, a part of one removed (the folder was empty, all are ours).
        if (realNames) {
          changed = true;
          await keepWhole(sent, error);
        } else await inPool(sent, context.parallel, (item) => settleTemp(item.temp, error));
        return;
      }
      if (realNames) {
        for (const { upload } of sent) landed(upload);
        return;
      }
      await inPool(sent, context.parallel, async (item) => {
        const { upload, temp } = item;
        const renamed = await attempt(async () => {
          await session.rename(joinServer(root, temp), joinServer(root, upload.path));
          return true;
        }, upload.path);
        if (renamed === 'done') {
          inFlight.delete(temp);
          landed(upload);
          return;
        }
        if (renamed === 'failed') refused++;
        await settleTemp(temp, error);
      });
    };

    /**
     * A file written from a secret (R17, R18): from memory to its temp name, with its mode set
     * before the first byte, then renamed over the final name.
     */
    const write = async (op: Write): Promise<void> => {
      const result = await attempt(async () => {
        const file = context.writes.get(op.path);
        if (file === undefined) throw new RangeError(`planned write not in the target: ${op.path}`);
        return viaTemp(op.path, (temp) =>
          session.put({ secret: file.secret }, temp, { mode: file.mode }),
        );
      }, op.path);
      if (result === 'done') written++;
    };
    const remove = async (op: Delete): Promise<void> => {
      if (await step(() => session.remove(joinServer(root, op.path)), op.path)) {
        deleted.add(op.path);
        version++;
      }
    };

    // After a failure no new op starts (step does nothing once the run has stopped): the site
    // never loses a file before its replacement is in.
    for (const group of groups(plan.ops)) {
      if (group.at === making) {
        wayClear = !stopped();
        version++;
      }
      if (group.kind === 'upload') {
        const ups = group.ops.filter(isUpload);
        if (session.archive !== undefined) await sendArchive(session.archive, ups);
        else await inPool(ups, context.parallel, send);
      } else if (group.kind === 'write') {
        await inPool(group.ops.filter(isWrite), context.parallel, write);
      } else if (group.kind === 'delete') {
        await inPool(group.ops.filter(isDelete), context.parallel, remove);
      } else {
        // A level at a time: parents first for mkdirs, deepest first for rmdirs. The folders of
        // one depth run `parallel` at once; the next level starts once they have all finished.
        for (const level of levels(group.ops, group.kind === 'mkdir' ? 'outermost' : 'deepest')) {
          await inPool(level, context.parallel, async (op) => {
            const at = joinServer(root, op.path);
            await step(() => (op.op === 'mkdir' ? session.mkdir(at) : session.rmdir(at)));
          });
        }
      }
    }
  } finally {
    clearInterval(timer);
    // A checkpoint still on its way must land before the final write, never over it; a note
    // still on its way, before the lock is released.
    await Promise.all([saving, beating]);
  }

  const uploads = plan.ops.filter(isUpload);
  let recorded = false;
  // Written when a record changes: a file arrived, or a recorded file is gone (even one someone
  // had removed already, which changed nothing on the server), or a record is forgotten; when
  // temp names were or are left; and after a checkpoint, so the last word is the final one.
  const records = arrived.size > 0 || gone().length > 0 || forgotten.length > 0;
  const temps = context.leftovers.length > 0 || pending.size > 0;
  const record = snapshot();
  if (records || temps || checkpoints > 0 || context.resumed === true) {
    // Written even after a failure or Ctrl-C: it records what really arrived and what was
    // really deleted, so a rerun does the rest.
    try {
      await context.store.write(record);
      recorded = true;
    } catch (caught) {
      error ??= asError(caught);
    }
  }
  return {
    uploaded: arrived.size,
    written,
    deleted: deleted.size,
    bytes,
    changed,
    interrupted: signal?.aborted === true,
    // In path order, not the order the answers came back in.
    failed: failed.sort((a, b) => comparePaths(a.path, b.path)),
    run: {
      uploads: uploads.length,
      arrived: arrived.size,
      missing: uploads
        .filter((upload) => !arrived.has(upload.path))
        .map((upload) => ({ path: upload.path, size: upload.size })),
      refused,
      writes: plan.ops.filter(isWrite).length,
      written,
      deletes: plan.ops.filter(isDelete).length,
      deleted: deleted.size,
      recorded,
    },
    record,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Removes what a failed upload left under its temp name, when the server still answers (after a
 * timeout or a lost connection another request would only wait or fail). Best effort: the rerun
 * uploads under a new name anyway.
 */
async function removeTemp(session: Session, temp: ServerPath, caught: unknown): Promise<boolean> {
  if (caught instanceof TransportError && ['timeout', 'connection-lost'].includes(caught.code)) {
    return false;
  }
  try {
    await session.remove(temp);
    return true;
  } catch {
    // Left behind: the manifest lists it, and the next run removes it (decision 0032).
    return false;
  }
}

/**
 * Whether the target folder is missing or empty before the run's first change: the archive may
 * then write real names (0007 §4). Any doubt (an error, an entry) is no.
 */
async function emptyFolder(session: Session, root: ServerPath): Promise<boolean> {
  try {
    const listed = await session.list(root, 0);
    return listed.kind === 'not-found' || (listed.kind === 'found' && listed.entries.length === 0);
  } catch {
    return false;
  }
}

/** Decision 0032: the manifest is written at least this often during a transfer, in ms. */
const checkpointEvery = 30_000;

/** What was thrown, as an Error (anything can be thrown in JavaScript). */
function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

interface Group {
  readonly kind: PlanOp['op'];
  /** The index of its first op in the plan. */
  readonly at: number;
  readonly ops: PlanOp[];
}

/** The ops in runs of one kind, in plan order. */
function groups(ops: readonly PlanOp[]): Group[] {
  const out: Group[] = [];
  ops.forEach((op, at) => {
    const last = out.at(-1);
    if (last?.kind === op.op) last.ops.push(op);
    else out.push({ kind: op.op, at, ops: [op] });
  });
  return out;
}

/** The ops by the depth of their path, outermost or deepest level first, plan order within one. */
function levels(ops: readonly PlanOp[], first: 'outermost' | 'deepest'): PlanOp[][] {
  const byDepth = new Map<number, PlanOp[]>();
  for (const op of ops) {
    const at = depth(op.path);
    const level = byDepth.get(at);
    if (level === undefined) byDepth.set(at, [op]);
    else level.push(op);
  }
  const order = first === 'outermost' ? 1 : -1;
  return [...byDepth].sort(([a], [b]) => order * (a - b)).map(([, level]) => level);
}

const isUpload = (op: PlanOp): op is Upload => op.op === 'upload';
const isWrite = (op: PlanOp): op is Write => op.op === 'write';
const isDelete = (op: PlanOp): op is Delete => op.op === 'delete';

/**
 * Runs `work` on each item, `limit` at once, taken in order: the pool every transfer runs in
 * (`parallel`), pull's downloads too (0026 point 8: one copy, no utility module).
 */
export async function inPool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}
