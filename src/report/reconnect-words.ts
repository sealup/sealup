// The words of a reconnect (S11, spec #41 decision 20): the `!` line before each try and the dim
// line once logged in again, between the progress lines; then, on a run that ended well, the
// dim `reconnected once` in the result's extras, GitHub's notice and the summary's NOTE box.
// Pure (import rules, pure file): no node: import.

import type { DeployEvent, Target } from '../contracts/index.ts';
import type { Annotation } from './annotations.ts';
import { formatCount, type Line, plural, style, times } from './format.ts';

type Reconnecting = Extract<DeployEvent, { type: 'reconnecting' }>;
type Reconnected = Extract<DeployEvent, { type: 'reconnected' }>;

/** What the reporters keep of a run's reconnects: the first loss, and the try that came back. */
export interface Reconnects {
  readonly lost: Reconnecting;
  readonly back?: Reconnected;
}

/** Adds an event to what a reporter keeps: the first loss, then the first try back. */
export function noted(
  seen: Reconnects | undefined,
  event: Reconnecting | Reconnected,
): Reconnects | undefined {
  if (event.type === 'reconnecting') return seen ?? { lost: event };
  if (seen === undefined || seen.back !== undefined) return seen;
  return { ...seen, back: event };
}

/** The `!` line before a try: what was lost the first time, then that it is still lost. */
export function reconnectingLines(event: Reconnecting, target: Target | undefined): Line[] {
  const { attempt, attempts, files, totalFiles } = event;
  const at =
    totalFiles === 0 ? '' : ` after ${formatCount(files)} of ${formatCount(totalFiles)} files`;
  const host = target?.server.host ?? 'The server';
  const what =
    attempt > 1
      ? 'Still no connection.'
      : event.code === 'timeout'
        ? `${host} stopped answering${at}.`
        : `Connection lost${at}.`;
  return [['  ', style(`! ${what} Reconnecting (${attempt} of ${attempts})…`, 'yellow')]];
}

/** The dim line once logged in again: what the transfer still has to send. */
export function reconnectedLines(event: Reconnected): Line[] {
  const left = event.filesLeft === 0 ? '' : `: ${plural(event.filesLeft, 'file')} left`;
  return [['    ', style(`Reconnected. Resuming${left}.`, 'dim')]];
}

/** The rest sent after the first loss, in words: `sent the other 118`, or `finished the run`. */
function rest(seen: Reconnects): string {
  const other = seen.lost.totalFiles - seen.lost.files;
  return other > 0 ? `sent the other ${formatCount(other)}` : 'finished the run';
}

/** Where the first loss came, in words: `after 182 of 300 files`, or nothing. */
function after(seen: Reconnects): string {
  const { files, totalFiles } = seen.lost;
  if (totalFiles === 0) return '';
  return ` after ${formatCount(files)} of ${formatCount(totalFiles)} files`;
}

/** GitHub's notice of a run that reconnected and ended well (S11). */
export function reconnectNotice(seen: Reconnects, count: number, target: Target): Annotation {
  const host = target.server.host;
  const message =
    count === 1
      ? `The connection to ${host} dropped${after(seen)}. sealup reconnected and ${rest(seen)}; nothing is missing.`
      : `The connection to ${host} dropped ${times(count)}. sealup reconnected each time and finished the run; nothing is missing.`;
  return { level: 'notice', title: `Reconnected ${times(count)}`, message };
}

/** The job summary's NOTE box of a run that reconnected and ended well (S11). */
export function reconnectBox(seen: Reconnects, count: number): string {
  const tries =
    seen.back === undefined ? '' : ` (${seen.back.attempt} of ${seen.lost.attempts} tries)`;
  const text =
    count === 1
      ? `The connection dropped${after(seen)}. sealup reconnected${tries} and ${rest(seen)}; nothing is missing.`
      : `The connection dropped ${times(count)}. sealup reconnected each time and finished the run; nothing is missing.`;
  return ['> [!NOTE]', `> ${text}`].join('\n');
}
