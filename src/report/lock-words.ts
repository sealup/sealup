// The words of the lock (decision 0031): a held lock that stops a deploy (exit 6, `lock-held`),
// and the warning of a lock found and gone past: a dry run's, or a deploy's takeover of a dead
// run's lock. A note comes from the server: every string of it is printed safely. Pure (import
// rules, pure file): no node: import.

import type { DeployEvent, LockHolder, Problem } from '../contracts/index.ts';
import { type Line, printable, style } from './format.ts';
import type { Explained } from './problems.ts';

type LockHeld = Extract<Problem, { code: 'lock-held' }>;
type LockEvent = Extract<DeployEvent, { type: 'lock' }>;

/** The longest a note's string is printed: a hostile note cannot flood the log. */
const maxShown = 80;

/** A held lock (exit 6): who holds it and since when, and the way out. */
export function explainLockHeld(problem: LockHeld): Explained {
  const { holder, target } = problem;
  const state = [`Nothing was changed on ${target}.`];
  if (holder === undefined) {
    return {
      title: `Another run holds ${target}: sealup stopped.`,
      details: [
        'Its lock has no note sealup can read, so sealup cannot tell whose it is.',
        `If no run is deploying to ${target}, remove this folder on the server:`,
        `  ${printable(problem.lock)}`,
      ],
      state,
      slug: 'lock-held',
    };
  }
  return {
    title: `Another run is deploying to ${target}: sealup stopped.`,
    details: [
      `${runWords(holder)} has held it since ${utc(holder.started)}.`,
      ...(holder.ciRun === undefined ? [] : [`CI run: ${shown(holder.ciRun)}`]),
      'Let it finish, then deploy again. A lock whose run died is taken over',
      'once its note is 10 minutes old.',
    ],
    state,
    slug: 'lock-held',
  };
}

/**
 * The warning of a lock found held when the run goes on: a deploy that took over a dead run's
 * lock, or a dry run (which never takes one). A `!` in yellow, then the run it names.
 */
export function lockLines(event: LockEvent, dryRun: boolean, target: string): Line[] {
  const lines = lockWords(event, dryRun, target).map(
    (text, at): Line => (at === 0 ? ['  ', style('!', 'yellow'), ' ', text] : [`    ${text}`]),
  );
  // A blank line, as after the target block: the plan comes next.
  return [...lines, []];
}

/** The warning's title and its lines, for an annotation or the summary's box. */
export function lockWords(event: LockEvent, dryRun: boolean, target: string): string[] {
  const { holder, stale } = event;
  if (holder === undefined) {
    return dryRun
      ? [`Another run holds ${target}: a deploy now would stop.`]
      : ['Took over a lock with no note: its run stopped before writing one.'];
  }
  const silent = event.silentMs === undefined ? '' : ` ${minutes(event.silentMs)} ago`;
  const who = `${runWords(holder)}, started ${utc(holder.started)}.`;
  const dead = `the lock of a run that stopped answering${silent}:`;
  if (!dryRun) return [`Took over ${dead}`, lower(who)];
  if (stale) return [`A deploy would take over ${dead}`, lower(who)];
  return [`Another run is deploying to ${target}: a deploy now would stop.`, who];
}

/** `Run <id> on <machine>`. */
function runWords(holder: LockHolder): string {
  return `Run ${shown(holder.run)} on ${shown(holder.machine)}`;
}

/** The first letter in lower case: the run's line continues the sentence above it. */
function lower(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** A note's string as it can be printed: one line, at most `maxShown` characters. */
function shown(text: string): string {
  const safe = printable(text);
  return safe.length > maxShown ? `${safe.slice(0, maxShown - 1)}…` : safe;
}

/** `2026-10-09 08:15 UTC`: another machine's time, the same for every reader. */
function utc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Whole minutes, `25 min`; under one, `less than a minute`. */
function minutes(ms: number): string {
  const whole = Math.floor(ms / 60_000);
  return whole < 1 ? 'less than a minute' : `${whole} min`;
}
