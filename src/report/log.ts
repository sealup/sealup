// The lines only the log forms print (decision 0024 §9, spec #24 decisions 27-31): the timing
// line after the result, the 25/50/75 % lines, GitHub's change group, and the GitHub workflow
// commands with their escaping. Pure (import rules, pure file): no node: import.

import type { Outcome, Plan, Progress } from '../contracts/index.ts';
import {
  aligned,
  changes,
  formatCount,
  formatSeconds,
  type Line,
  progressParts,
  reconnectTime,
  verboseLines,
} from './format.ts';

/**
 * A workflow command's message as GitHub reads it back (its toolkit's escapeData): `%`, CR and
 * LF escaped, so a value can neither end the command nor start a line of its own.
 */
function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** A workflow command's property value (its toolkit's escapeProperty): also `:` and `,`. */
function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** `::name key=value,…::message`, every part escaped. */
export function command(
  name: string,
  properties: Readonly<Record<string, string | number | undefined>>,
  message: string,
): string {
  const props = Object.entries(properties)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${escapeProperty(String(value))}`);
  return `::${name}${props.length === 0 ? '' : ` ${props.join(',')}`}::${escapeData(message)}`;
}

/** GitHub's collapsed group: the commands that open and close it, and the lines inside. */
export interface Group {
  readonly open: string;
  readonly lines: readonly Line[];
  readonly close: string;
}

/**
 * GitHub's group of every change of a run (0024 §7, spec #24 decision 29): its title counts
 * them, then the list as `-v` shows it, sizes in their column. None when nothing changes.
 */
export function groupOf(plan: Plan): Group | undefined {
  const { uploads, writes, deletes } = changes(plan);
  const counts = [
    [uploads.length, 'upload'],
    [writes.length, 'write'],
    [deletes.length, 'delete'],
    [plan.kept.length, 'keep'],
  ] as const;
  const title = counts
    .filter(([n]) => n > 0)
    .map(([n, verb]) => `${formatCount(n)} ${verb}`)
    .join(', ');
  if (title === '') return undefined;
  return {
    open: command('group', {}, `Changes: ${title}`),
    lines: verboseLines(plan),
    close: command('endgroup', {}, ''),
  };
}

/** The marks a long transfer prints, by bytes (0024 §9). */
const marks = [75, 50, 25] as const;
/** A mark is printed only when the transfer at that pace takes longer (spec #24 decision 28). */
const longTransferMs = 5_000;

/**
 * The percentage lines of a log, from the progress events: `next(progress)` gives the line for
 * the highest mark that event crosses, if any, and none when the projected time (elapsed ÷ share
 * done) is 5 s or less. Each mark is judged when it is crossed; a mark passed quietly is not
 * printed later. Elapsed is the transfer's (S07: 25 % at 3.4 s of a 13.7 s transfer).
 */
export function percentLines(): { next(progress: Progress): Line | undefined } {
  let passed = 0;
  return {
    next(progress) {
      if (progress.totalBytes === 0) return undefined;
      const share = progress.bytes / progress.totalBytes;
      const mark = marks.find((m) => share * 100 >= m);
      if (mark === undefined || mark <= passed) return undefined;
      passed = mark;
      if (progress.transferMs / share <= longTransferMs) return undefined;
      const { files, bytes, seconds } = progressParts({
        ...progress,
        elapsedMs: progress.transferMs,
      });
      return aligned(`  ↑ ${mark} %   ${files}`, `${bytes}   ${seconds}`);
    },
  };
}

/**
 * Where the time went, under the result of a log form (the page's CI forms, S07-S09): plain, one
 * line; the transfer only when something travelled (S09 has none).
 */
export function logTimingLines(outcome: Outcome): Line[] {
  const phases =
    outcome.status === 'unchanged'
      ? (['connect', 'scan', 'compare'] as const)
      : (['connect', 'scan', 'compare', 'transfer'] as const);
  const parts = phases.map((phase) => `${phase} ${formatSeconds(outcome.timings[phase])}`);
  return [[`    ${[...parts, ...reconnectTime(outcome.timings)].join(' · ')}`]];
}
