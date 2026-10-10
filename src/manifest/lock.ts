// The lock of a target folder (decisions 0031, 0040): one run at a time. A folder
// `<manifest name>.lock` beside the manifest, made with mkdir (the server decides which of two
// runs made it), holding `note.json`: who holds it and since when; a dead run's lock also holds
// the `took-<n>` folders that claimed it. Its age is the server's. Its note is untrusted input
// (R12): decoded strictly.

import { randomBytes } from 'node:crypto';
import {
  type LockHolder,
  type RemotePath,
  type ServerPath,
  type Session,
  TransportError,
} from '../contracts/index.ts';
import { foldersToMake, joinServer, parseRemotePath } from '../paths/index.ts';

/** Who runs this deploy, for its note: this machine's name, and its CI run's page if any. */
export interface Runner {
  readonly machine: string;
  readonly ciRun?: string;
}

/** A lock this run holds. */
export interface HeldLock {
  /** The note's first write: settles once it is on the server (a failure is the caller's). */
  readonly ready: Promise<void>;
  /** Rewrites the note with the time now (every 30 s of transfer). */
  refresh(): Promise<void>;
  /**
   * Removes the note, then the folder, once the first write settled. Best effort: never throws.
   * `changedNothing`: the run stopped before any change, so the manifest folder and the parents
   * this lock's mkdir made go too, as they were never there (an rmdir leaves a folder not empty).
   */
  release(options?: { readonly changedNothing?: boolean }): Promise<void>;
  /**
   * The same lock over another session of the same server, after a reconnect (spec #41
   * decision 20): the lock belongs to the target folder, not to the connection, so it is never
   * taken again; its note is refreshed and it is released over the new session.
   */
  on(session: Session): HeldLock;
}

/**
 * A dead run's lock this run took over: its note and its silence (ms), or no note at all (a run
 * that stopped between making the folder and writing its note).
 */
type TookOver =
  | { readonly holder: LockHolder; readonly silentMs: number }
  | { readonly noNote: true };

export type LockTaken =
  | { readonly kind: 'taken'; readonly lock: HeldLock; readonly tookOver?: TookOver }
  | { readonly kind: 'held'; readonly holder?: LockHolder };

export type LockSeen =
  | { readonly kind: 'free' }
  | {
      readonly kind: 'held';
      readonly holder: LockHolder;
      readonly stale: boolean;
      readonly silentMs: number;
    };

/**
 * A lock the server has seen nothing of for this long is a dead run's: taken over (decisions
 * 0031, 0040). A dry run measures its note's `refreshed` against this machine's clock instead.
 */
const staleAfterMs = 10 * 60_000;

/** A note is a few hundred bytes; more is not sealup's (R21). */
const maxNoteBytes = 64 * 1024;

/** The note's format version: a note of another is never taken over. */
const noteFormat = 1;

interface LockPlace {
  readonly session: Session;
  /** The manifest folder, absolute. */
  readonly folder: ServerPath;
  /** The lock folder, absolute. */
  readonly path: ServerPath;
}

/** What the lock folder holds: a note, none (missing or empty), or one sealup cannot trust. */
type NoteRead =
  | { readonly kind: 'note'; readonly holder: LockHolder }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable' };

/**
 * Takes the lock, or says who holds it (decisions 0031, 0040). A lock found dead (`judge`) is
 * claimed, never removed: `mkdir` of the next `took-<n>` inside it, so of two runs that judged
 * the same lock the server lets one through; the other stops. The winner keeps the folder and
 * writes its own note over the dead one.
 */
export async function takeLock(
  place: LockPlace,
  runner: Runner,
  now: () => number,
): Promise<LockTaken> {
  const { session, path } = place;
  let lost = false;
  /** The folders above the lock this run made, outermost first. */
  const made: ServerPath[] = [];
  // The lock can come and go between two requests; a few rounds settle it.
  for (let round = 0; round < 4; round++) {
    if (await makeFolder(place, made)) {
      return { kind: 'taken', lock: held(place, runner, now, { claims: [], made }) };
    }
    const seen = await judge(place);
    if (seen.kind === 'gone') continue;
    // A note sealup cannot trust is never taken over: its words name the folder to remove.
    if (seen.kind === 'unreadable') return { kind: 'held' };
    const holder = seen.holder === undefined ? {} : { holder: seen.holder };
    // Claimed once: a run that lost the claim stops; the winner holds it now.
    if (seen.kind === 'alive' || lost) return { kind: 'held', ...holder };
    const claim = `took-${seen.claims.next}`;
    const claimPath = joinServer(path, remotePath(claim));
    let won: boolean;
    try {
      // Strict: a claim is tried once. One that failed is lost, even once it is gone (its
      // winner released the lock, and another run may hold it again).
      won = await session.mkdir(claimPath);
    } catch (error) {
      // Released in between: the lock is free to make again.
      if (error instanceof TransportError && error.code === 'not-found') continue;
      if (!(await goneSinceFailure(session, claimPath, error))) throw error;
      won = false;
    }
    if (!won) {
      lost = true;
      continue;
    }
    const lock = held(place, runner, now, { claims: [...seen.claims.names, claim], made });
    const tookOver: TookOver =
      seen.holder === undefined
        ? { noNote: true }
        : { holder: seen.holder, silentMs: seen.silentMs };
    return { kind: 'taken', lock, tookOver };
  }
  return { kind: 'held' };
}

/** What a lock found in place is: alive, dead (to claim), unreadable, or gone meanwhile. */
type Judged =
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'alive'; readonly holder?: LockHolder }
  | {
      readonly kind: 'dead';
      readonly holder?: LockHolder;
      readonly silentMs: number;
      readonly claims: Claims;
    };

/** The claims inside a lock folder: their names, and the number the next one takes. */
interface Claims {
  readonly names: readonly string[];
  readonly next: number;
}

/** A lock folder holds a note and its claims; more than this is not sealup's. */
const maxLockEntries = 1_000;

/** `took-<n>`: a run's claim on a dead lock (decision 0040). */
const claimName = /^took-([1-9]\d{0,8})$/;

/** The manifest folder holds a manifest and a lock per target folder: more is not looked at. */
const maxManifestFolderEntries = 10_000;

/**
 * Judges the lock in place by the server's clock (decision 0040): its last sign of life is the
 * newest date inside it (the note, the claims), or the folder's own when it is empty; the
 * server's now is the date of a file this run writes beside it, lists and removes. Dead: no
 * sign of life for `staleAfterMs`, note or no note. A lock it cannot date counts as alive.
 */
async function judge({ session, folder, path }: LockPlace): Promise<Judged> {
  const lockName = path.slice(path.lastIndexOf('/') + 1);
  const clockName = `${lockName}.clock-${randomBytes(8).toString('hex')}`;
  const clock = joinServer(folder, remotePath(clockName));
  const [found, inside] = await Promise.all([
    readNote(session, notePath(path)),
    session.list(path, maxLockEntries),
    session.put({ bytes: new Uint8Array() }, clock),
  ]);
  let around: Awaited<ReturnType<Session['list']>>;
  try {
    around = await session.list(folder, maxManifestFolderEntries);
  } finally {
    await session.remove(clock);
  }
  if (inside.kind === 'not-found') return { kind: 'gone' };
  if (found.kind === 'unreadable' || inside.kind === 'too-many') return { kind: 'unreadable' };
  const holder = found.kind === 'note' ? { holder: found.holder } : {};
  const dated = around.kind === 'found' ? around.entries : [];
  const serverNow = dated.find((entry) => entry.name === clockName)?.mtime;
  const lockDate = dated.find((entry) => entry.name === lockName)?.mtime;
  const lastSign =
    inside.entries.length > 0 ? Math.max(...inside.entries.map((entry) => entry.mtime)) : lockDate;
  if (serverNow === undefined || lastSign === undefined) return { kind: 'alive', ...holder };
  const silentMs = (serverNow - lastSign) * 1000;
  if (silentMs < staleAfterMs) return { kind: 'alive', ...holder };
  const names = inside.entries
    .filter((entry) => entry.kind === 'folder' && claimName.test(entry.name))
    .map((entry) => entry.name);
  const next = Math.max(0, ...names.map((name) => Number(claimName.exec(name)?.[1]))) + 1;
  return { kind: 'dead', ...holder, silentMs, claims: { names, next } };
}

/**
 * The lock this run holds, made or claimed: its note goes out now, beside the caller's next
 * request.
 */
function held(
  { session, path }: LockPlace,
  runner: Runner,
  now: () => number,
  { claims, made }: Omit<HeldPlace, 'path'>,
): HeldLock {
  const note = { run: randomBytes(8).toString('hex'), started: now(), ...runner };
  const lock = holding(session, { path, claims, made }, note, now);
  // The caller awaits `ready`; this only keeps an early stop from leaving it unhandled.
  lock.ready.catch(() => {});
  return lock;
}

/** Where a held lock is: its folder, the claims inside it, the folders above it this run made. */
interface HeldPlace {
  readonly path: ServerPath;
  /** The `took-` folders inside it, removed with it. */
  readonly claims: readonly string[];
  /** Outermost first. */
  readonly made: readonly ServerPath[];
}

/**
 * The lock at `place` that the run `note` names holds, over `session`. Its note is written now,
 * unless `ready` says it was already (the same lock over a new session).
 */
function holding(
  session: Session,
  place: HeldPlace,
  note: Omit<LockHolder, 'refreshed'>,
  now: () => number,
  ready?: Promise<void>,
): HeldLock {
  const { path, claims, made } = place;
  const notes = notePath(path);
  const write = () => session.put({ bytes: encodeNote({ ...note, refreshed: now() }) }, notes);
  const written = ready ?? write();
  return {
    ready: written,
    refresh: write,
    async release(options = {}) {
      await written.catch(() => {});
      try {
        await session.remove(notes);
        for (const claim of claims) await session.rmdir(joinServer(path, remotePath(claim)));
        await session.rmdir(path);
        if (options.changedNothing === true) {
          for (const folder of [...made].reverse()) await session.rmdir(folder);
        }
      } catch {
        // Left: the next run takes it over (decision 0031).
      }
    },
    on: (other) => holding(other, place, note, now, Promise.resolve()),
  };
}

/** What a dry run sees: a note, held or stale; no note, or one it cannot read, is free to it. */
export async function seeLock(place: LockPlace, now: () => number): Promise<LockSeen> {
  const found = await readNote(place.session, notePath(place.path));
  if (found.kind !== 'note') return { kind: 'free' };
  const silentMs = now() - found.holder.refreshed;
  return { kind: 'held', holder: found.holder, stale: silentMs >= staleAfterMs, silentMs };
}

/**
 * mkdir of the lock folder: whether this run made it. Its parents are made when missing; each one
 * this run made is added to `made`.
 */
async function makeFolder(
  { session, folder, path }: LockPlace,
  made: ServerPath[],
): Promise<boolean> {
  try {
    return await mkdirLock(session, path);
  } catch (error) {
    if (!(error instanceof TransportError) || error.code !== 'not-found') throw error;
  }
  for (const parent of foldersToMake(session.loginFolder, folder)) {
    if (await session.mkdir(parent)) made.push(parent);
  }
  return mkdirLock(session, path);
}

/**
 * mkdir of the lock folder. One that failed on a lock its holder released before the session
 * looked (gone again) is tried once more: the lock is free. Never used for a claim.
 */
async function mkdirLock(session: Session, path: ServerPath): Promise<boolean> {
  try {
    return await session.mkdir(path);
  } catch (error) {
    if (!(await goneSinceFailure(session, path, error))) throw error;
    return session.mkdir(path);
  }
}

/**
 * Whether `error`, from a mkdir of `path`, is the server's failure on something that was there
 * and is gone now: SFTP and FTP say only "failed", and the session's look found nothing.
 */
async function goneSinceFailure(
  session: Session,
  path: ServerPath,
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof TransportError) || error.code !== 'protocol') return false;
  return (await session.stat(path)).kind === 'not-found';
}

function notePath(lock: ServerPath): ServerPath {
  return joinServer(lock, remotePath('note.json'));
}

/** One of the lock's own names (`note.json`, `took-2`) as a RemotePath. */
function remotePath(name: string): RemotePath {
  const parsed = parseRemotePath(name);
  if (!parsed.ok) throw new RangeError(`${name} is a remote path`);
  return parsed.path;
}

/** The note in the lock folder. A lost connection or a timeout stays what it is. */
async function readNote(session: Session, path: ServerPath): Promise<NoteRead> {
  let read: Awaited<ReturnType<Session['read']>>;
  try {
    read = await session.read(path, maxNoteBytes);
  } catch (error) {
    if (error instanceof TransportError && ['permission', 'protocol'].includes(error.code)) {
      return { kind: 'unreadable' };
    }
    throw error;
  }
  if (read.kind === 'not-found') return { kind: 'none' };
  if (read.kind === 'too-large') return { kind: 'unreadable' };
  // An empty note: a run whose connection dropped once the file was opened.
  if (read.bytes.length === 0) return { kind: 'none' };
  const holder = decodeNote(read.bytes);
  return holder === undefined ? { kind: 'unreadable' } : { kind: 'note', holder };
}

function encodeNote(holder: LockHolder): Uint8Array {
  const { run, started, refreshed, machine, ciRun } = holder;
  return new TextEncoder().encode(
    `${JSON.stringify({
      sealupLock: noteFormat,
      run,
      started: new Date(started).toISOString(),
      refreshed: new Date(refreshed).toISOString(),
      machine,
      ...(ciRun === undefined ? {} : { ciRun }),
    })}\n`,
  );
}

const noteKeys = new Set(['sealupLock', 'run', 'started', 'refreshed', 'machine', 'ciRun']);

/** A note's bytes as a LockHolder: strict (R12), undefined for anything else. */
function decodeNote(bytes: Uint8Array): LockHolder | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const note = value as Record<string, unknown>;
  if (Object.keys(note).some((key) => !noteKeys.has(key))) return undefined;
  if (note.sealupLock !== noteFormat) return undefined;
  const { run, machine, ciRun } = note;
  const started = time(note.started);
  const refreshed = time(note.refreshed);
  if (!text(run, 64) || !text(machine, 255) || started === undefined || refreshed === undefined) {
    return undefined;
  }
  if (ciRun !== undefined && !text(ciRun, 2048)) return undefined;
  return { run, started, refreshed, machine, ...(ciRun === undefined ? {} : { ciRun }) };
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** An ISO time (UTC, `Z`) as ms since 1970; undefined for anything else. */
function time(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}
