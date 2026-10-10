// The lines of `sealup pull` (S24, spec #24 decision 25): the direction (server on the left),
// what is new, to replace and already here, the skipped links, once that local files are never
// deleted, the dry run's list, the result. Pure (import rules, pure file): no node: import.

import type { Outcome, PullDownload, PullPlan, Target } from '../contracts/index.ts';
import {
  aligned,
  dryRunLabel,
  fileLines,
  formatBytes,
  formatCount,
  formatSeconds,
  type Line,
  plural,
  style,
  withRight,
} from './format.ts';

/** `Pull  <server path> → <local>`, one line per entry, the next ones under the first's paths. */
function directionLines(plan: PullPlan): Line[] {
  return plan.entries.map((entry, i): Line => {
    const way = `${entry.remote === '' ? '.' : entry.remote} → ${entry.localFromConfig}`;
    return i === 0 ? ['  ', style('Pull', 'bold'), `  ${way}`] : [`        ${way}`];
  });
}

const sameSizeAndDate = 'already here (same size and date)';

/** The links and special files the server holds, skipped, one dim line each when any. */
function skippedLines(plan: PullPlan): Line[] {
  const lines: Line[] = [];
  if (plan.links > 0) {
    lines.push([
      '  ',
      style(
        `${plural(plan.links, 'link')} on the server skipped: sealup never follows one.`,
        'dim',
      ),
    ]);
  }
  if (plan.special > 0) {
    const text = `${plural(plan.special, 'special file')} on the server skipped (sockets, devices, pipes).`;
    lines.push(['  ', style(text, 'dim')]);
  }
  return lines;
}

const neverDeleted: Line = ['  ', style('Local files are never deleted.', 'dim')];

/** One download in a list: `+` new, `~` replace, its local path and its size at column 72. */
function downloadLines(download: PullDownload): Line[] {
  const symbol = download.reason === 'new' ? style('+', 'green') : '~';
  return fileLines(symbol, download.to, { right: formatBytes(download.size) });
}

/** The new ones first, then the ones to replace, each in path order. */
function byReason(plan: PullPlan): { fresh: PullDownload[]; replaced: PullDownload[] } {
  return {
    fresh: plan.downloads.filter((download) => download.reason === 'new'),
    replaced: plan.downloads.filter((download) => download.reason === 'replace'),
  };
}

/**
 * A real pull's plan (S24): the direction, the counts and bytes, the skipped links, the file
 * list with `-v`, and once that local files are never deleted.
 */
export function pullPlanLines(plan: PullPlan, verbose: boolean): Line[] {
  const { fresh, replaced } = byReason(plan);
  const counts = [plural(fresh.length, 'new file')];
  if (replaced.length > 0) counts.push(`${formatCount(replaced.length)} to replace`);
  if (plan.unchanged > 0) counts.push(`${formatCount(plan.unchanged)} ${sameSizeAndDate}`);
  return [
    ...directionLines(plan),
    aligned(`  ${counts.join(' · ')}`, formatBytes(plan.bytes)),
    ...(verbose ? [...fresh, ...replaced].flatMap(downloadLines) : []),
    ...skippedLines(plan),
    neverDeleted,
  ];
}

/** The first line of a pull's dry run, above the target block. */
export function pullDryRunStartLines(target: Target): Line[] {
  return [dryRunLabel(`nothing will be downloaded from ${target.name}`)];
}

/** A pull's dry run (`-n`): every download under its reason, then what is already here. */
export function pullDryRunPlanLines(plan: PullPlan): Line[] {
  const { fresh, replaced } = byReason(plan);
  const lines: Line[] = directionLines(plan);
  if (fresh.length > 0) {
    const bytes = fresh.reduce((sum, download) => sum + download.size, 0);
    const head = `Would download ${plural(fresh.length, 'new file')}`;
    lines.push(withRight(['  ', style(head, 'bold')], formatBytes(bytes)));
    lines.push(...fresh.flatMap(downloadLines));
  }
  if (replaced.length > 0) {
    const bytes = replaced.reduce((sum, download) => sum + download.size, 0);
    const head = `Would replace ${plural(replaced.length, 'file')} (size or date differs)`;
    lines.push(withRight(['  ', style(head, 'bold')], formatBytes(bytes)));
    lines.push(...replaced.flatMap(downloadLines));
  }
  if (plan.downloads.length === 0) lines.push(['  Nothing would be downloaded.']);
  if (plan.unchanged > 0) lines.push([`  ${formatCount(plan.unchanged)} ${sameSizeAndDate}`]);
  lines.push(...skippedLines(plan), neverDeleted);
  return lines;
}

/** The last lines of a pull's dry run: the label again, and the command that pulls. */
export function pullDryRunEndLines(command: string): Line[] {
  return [[], dryRunLabel('nothing was downloaded. To pull: ', style(command, 'bold'))];
}

/** The result of a pull that ended well (S24): what arrived, then its bytes and where. */
export function pullResultLines(
  outcome: Outcome,
  target: Target,
  plan: PullPlan | undefined,
): Line[] {
  const time = formatSeconds(outcome.durationMs);
  const downloaded = outcome.downloaded ?? 0;
  if (downloaded === 0) {
    return [
      [
        '  ',
        style('✓ Already here:', 'boldGreen'),
        ` ${plural(outcome.unchanged, 'file')} checked against ${target.name} in ${time}.`,
      ],
    ];
  }
  const into = (plan?.entries ?? []).map((entry) => entry.localFromConfig).join(', ');
  return [
    [
      '  ',
      style('✓ Pulled', 'boldGreen'),
      ` ${plural(downloaded, 'file')} from ${target.name} in ${time}.`,
    ],
    ['    ', style(`${formatBytes(outcome.bytes)} · into ${into}`, 'dim')],
  ];
}
