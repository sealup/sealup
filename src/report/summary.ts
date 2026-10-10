// The GitHub job summary of a run (0024 §10, spec #24 decision 32; the page's summaries): one
// emoji in the heading (✅ ❌ ⚠️ 📋), a failure's caution box with **Fix:**, the target table
// always when the target is known (R22), the counts, the timing, the changes in a collapsed
// `diff` block cut after 1,000 lines (GitHub's 1 MiB limit), then sealup's version and a link.
// Markdown, from the run's facts only. Pure (import rules, pure file): no node: import; the
// reporter redacts it and hands it to the file.

import {
  type DeployEvent,
  type HostKeyCheck,
  isFtp,
  type Outcome,
  type PartialRun,
  type Plan,
  type Problem,
  type RunWarning,
  type Target,
} from '../contracts/index.ts';
import {
  changedOnServer,
  changes,
  fileName,
  formatBytes,
  formatCount,
  formatSeconds,
  formatServer,
  keptReasons,
  keyType,
  noHostKey,
  notInBuild,
  plural,
  printable,
  reconnectTime,
  resultWords,
} from './format.ts';
import { lockWords } from './lock-words.ts';
import type { Slug } from './problems.ts';
import { type Reconnects, reconnectBox } from './reconnect-words.ts';
import { code, summaryWords } from './summary-words.ts';
import { warningWords } from './warning-words.ts';

/** What the summary is made from: the run's events, gathered by the reporter. */
export interface SummaryRun {
  readonly version: string;
  /** The target, once chosen (or looked up by the name a problem gives before `start`). */
  readonly target: Target | undefined;
  /** The target's name when only a problem names it (a target sealup.yml could not resolve). */
  readonly targetName: string | undefined;
  readonly configFile: string;
  readonly dryRun: boolean;
  readonly hostKey: HostKeyCheck | undefined;
  /** Another run's lock, found and gone past (decision 0031): a WARNING box. */
  readonly lock?: Extract<DeployEvent, { type: 'lock' }>;
  readonly plan: Plan | undefined;
  /** The run's first lost connection and the try that came back (S11): a NOTE box. */
  readonly reconnected?: Reconnects;
  /** FTP: the connections the pool opened, when fewer than `parallel` (story 16). */
  readonly connections?: number;
  /** What the run risked without stopping (S23): a box each, before the target table. */
  readonly warnings: readonly RunWarning[];
  readonly outcome: Outcome;
  /** The command that applies a dry run (`sealup deploy production`). */
  readonly apply: string;
}

/** Lines of a change list shown at most; the rest are counted (GitHub's 1 MiB limit). */
const summaryListLines = 1_000;

/** The summary of a run, ending with a line break. */
export function summaryMarkdown(run: SummaryRun): string {
  const { outcome } = run;
  const blocks =
    outcome.problem === undefined ? doneBlocks(run) : problemBlocks(run, outcome.problem);
  return `${blocks.join('\n\n')}\n`;
}

/** A run that ended well, or a dry run that reached its plan (S07-S10). */
function doneBlocks(run: SummaryRun): string[] {
  const { outcome, plan, target } = run;
  const name = target?.name ?? run.targetName ?? 'the target';
  const time = formatSeconds(outcome.durationMs);
  // Over plain FTP, a run that ended well still gets ⚠️, and says how it went (S23).
  const ftp = run.warnings.some(({ code }) => code === 'plain-ftp');
  const [done, over] = ftp ? ['⚠️', ', over plain FTP'] : ['✅', ''];
  const [headline, rest] = resultWords(outcome, name);
  const heading = run.dryRun
    ? `### 📋 Dry run: nothing was changed on ${name}`
    : `### ${done} ${headline}: ${rest} in ${time}${over}`;
  const blocks = [heading, ...warningBoxes(run), ...lockBox(run), ...targetTable(run)];
  if (plan !== undefined)
    blocks.push(countsTable(run.dryRun ? dryRunRows(plan) : doneRows(outcome, plan)));
  if (plan?.firstDeploy === true) {
    blocks.push('First deploy: existing files stay. sealup only ever deletes files it uploaded.');
  }
  // A run that reconnected and ended well: a flaky host shows up in review (S11).
  const reconnects = outcome.reconnects ?? 0;
  if (reconnects > 0 && run.reconnected !== undefined) {
    blocks.push(reconnectBox(run.reconnected, reconnects));
  }
  if (run.dryRun) {
    blocks.push(`To apply: run ${code(run.apply)}, or this workflow without \`dry-run\`.`);
  }
  blocks.push(timing(outcome, run.dryRun, target, run.connections));
  if (plan !== undefined) blocks.push(...changesBlock(plan), ...skippedBlock(plan));
  blocks.push(footer(run.version));
  return blocks;
}

/** A run that stopped on a problem: the caution box first, so the fix is read first (S13-S21). */
function problemBlocks(run: SummaryRun, problem: Problem): string[] {
  const { outcome, target } = run;
  const words = summaryWords(problem, target, run.configFile);
  const name = target?.name ?? run.targetName;
  const nothing =
    outcome.status === 'failed' || (outcome.status === 'cancelled' && !changedBy(problem));
  const title =
    words.whole === true || !nothing
      ? words.title
      : `${words.title}: nothing was changed${name === undefined ? '' : ` on ${name}`}`;
  const emoji = nothing ? '❌' : '⚠️';
  const blocks = [
    `### ${emoji} ${title}`,
    caution(words.box),
    ...warningBoxes(run),
    ...lockBox(run),
    ...targetTable(run),
  ];
  const stopped = 'run' in problem ? problem.run : undefined;
  if (stopped !== undefined && run.plan !== undefined && changedBy(problem)) {
    blocks.push(countsTable(partRows(outcome, run.plan, stopped)));
    blocks.push(...notUploadedBlock(stopped));
  }
  blocks.push(footer(run.version, words.slug));
  return blocks;
}

function changedBy(problem: Problem): boolean {
  return 'changed' in problem && problem.changed !== false;
}

/** The lock's warning, when the run found another run's lock and went on (decision 0031). */
function lockBox(run: SummaryRun): string[] {
  if (run.lock === undefined) return [];
  const words = lockWords(run.lock, run.dryRun, run.target?.name ?? run.targetName ?? '');
  return [['> [!WARNING]', `> ${words.join(' ')}`].join('\n')];
}

/** `> [!CAUTION]`, then each paragraph quoted, a quoted blank line between them. */
function caution(paragraphs: readonly string[]): string {
  const quoted = paragraphs.map((paragraph) =>
    paragraph
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  );
  return ['> [!CAUTION]', quoted.join('\n>\n')].join('\n');
}

/** A `> [!WARNING]` box for each warning of the run (S23), once the target is known. */
function warningBoxes(run: SummaryRun): string[] {
  if (run.target === undefined) return [];
  return warningWords(run.warnings, run.target, run.configFile).map(({ box }) => box);
}

/** A table cell: a `|` would end it, even inside a code span (GitHub's tables). */
function cell(text: string): string {
  return text.replaceAll('|', '\\|');
}

/** The target, its host key and the site (R22): none when the run never knew the target. */
function targetTable(run: SummaryRun): string[] {
  const { target } = run;
  if (target === undefined) return [];
  const rows: [string, string][] = [['Target', code(formatServer(target.server))]];
  const check = run.hostKey;
  const expected = target.hostKey;
  const typed = (type: string, fingerprint: string): string =>
    `${keyType(type)} ${code(fingerprint)}`;
  if (check === undefined) {
    rows.push(['Host key', 'not checked: sealup stopped before connecting']);
  } else if (check.state === 'verified') {
    rows.push([
      'Host key',
      `${expected === undefined ? code(check.fingerprint) : typed(expected.type, check.fingerprint)} verified`,
    ]);
  } else if (check.state === 'none') {
    rows.push(['Host key', noHostKey]);
  } else if (check.state === 'certificate') {
    // FTPS (spec #41 decision 10): the certificate stands for the host key.
    const { subject, sha256 } = check.certificate;
    const how = check.check === 'refused' ? '**refused**' : check.check;
    rows.push(['Certificate', `${code(printable(subject))} SHA-256 ${code(sha256)} ${how}`]);
  } else if (check.state === 'missing') {
    rows.push(['Host key', `**missing** (no \`hostKey\` in ${fileName(run.configFile)})`]);
  } else if (check.state === 'changed') {
    if (expected !== undefined) {
      rows.push(['Host key expected', typed(expected.type, expected.fingerprint)]);
    }
    rows.push([
      'Host key received',
      `${typed(check.received.type, check.received.fingerprint)} **changed**`,
    ]);
  } else {
    const problem = run.outcome.problem;
    const ftp = problem?.code === 'transport' && problem.error.reason === 'speaks-ftp';
    rows.push([
      'Host key',
      ftp
        ? 'not checked: the port answered with FTP'
        : 'not checked: the connection failed before the server sent it',
    ]);
  }
  if (target.url !== undefined) rows.push(['Site', target.url]);
  const [head, ...rest] = rows.map(([key, value]) => `| ${key} | ${cell(value)} |`);
  return [[head, '|---|---|', ...rest].join('\n')];
}

type Row = readonly [label: string, files: string, size: string];

function countsTable(rows: readonly Row[]): string {
  return [
    '| | Files | Size |',
    '|---|---:|---:|',
    // An empty size is `| |`, as the page writes it.
    ...rows.map(
      ([label, files, size]) => `| ${label} | ${files} | ${size === '' ? '' : `${size} `}|`,
    ),
  ].join('\n');
}

const sized = (n: number): string => formatBytes(n);

function doneRows(outcome: Outcome, plan: Plan): Row[] {
  const rows: Row[] = [];
  if (outcome.uploaded > 0)
    rows.push(['Uploaded', formatCount(outcome.uploaded), sized(outcome.bytes)]);
  // A file written from a secret: never a size (R17).
  if (outcome.written > 0) rows.push(['Written', formatCount(outcome.written), '']);
  if (outcome.deleted > 0) rows.push(['Deleted', formatCount(outcome.deleted), '']);
  if (plan.unchanged > 0) {
    rows.push(['Unchanged', formatCount(plan.unchanged), sized(plan.unchangedBytes)]);
  }
  return rows;
}

function dryRunRows(plan: Plan): Row[] {
  const { uploads, writes, deletes } = changes(plan);
  const rows: Row[] = [];
  if (uploads.length > 0)
    rows.push(['Would upload', formatCount(uploads.length), sized(plan.bytes)]);
  if (writes.length > 0) rows.push(['Would write', formatCount(writes.length), '']);
  if (deletes.length > 0) rows.push(['Would delete', formatCount(deletes.length), '']);
  if (plan.kept.length > 0) rows.push(['Would keep', formatCount(plan.kept.length), '']);
  if (plan.unchanged > 0) {
    rows.push(['Unchanged', formatCount(plan.unchanged), sized(plan.unchangedBytes)]);
  }
  return rows;
}

/** A run that stopped part-way (S20): what arrived of what, what did not, the deletes held. */
function partRows(outcome: Outcome, plan: Plan, run: PartialRun): Row[] {
  const missingBytes = run.missing.reduce((sum, file) => sum + file.size, 0);
  const rows: Row[] = [
    [
      'Uploaded',
      `${formatCount(run.arrived)} of ${formatCount(run.uploads)}`,
      sized(outcome.bytes),
    ],
  ];
  if (run.missing.length > 0) {
    rows.push(['Not uploaded', formatCount(run.missing.length), sized(missingBytes)]);
  }
  if (run.writes > 0) {
    rows.push(['Written', `${formatCount(run.written)} of ${formatCount(run.writes)}`, '']);
  }
  if (run.deletes > 0) {
    const held = run.deleted < run.deletes && run.arrived < run.uploads;
    const note = held ? ' (kept until every upload is in)' : '';
    rows.push(['Deleted', `${formatCount(run.deleted)} of ${formatCount(run.deletes)}${note}`, '']);
  }
  if (plan.unchanged > 0) {
    rows.push(['Unchanged', formatCount(plan.unchanged), sized(plan.unchangedBytes)]);
  }
  return rows;
}

/**
 * Where the time went: the transfer only when something travelled (S09, S10 have none). Over FTP
 * it ends with the connections, the reason a run is slower (S23, story 16).
 */
function timing(
  outcome: Outcome,
  dryRun: boolean,
  target: Target | undefined,
  connections?: number,
): string {
  const phases =
    dryRun || outcome.status === 'unchanged'
      ? (['connect', 'scan', 'compare'] as const)
      : (['connect', 'scan', 'compare', 'transfer'] as const);
  const parts = phases.map((phase) => `${phase} ${formatSeconds(outcome.timings[phase])}`);
  parts.push(...reconnectTime(outcome.timings));
  if (target !== undefined && isFtp(target.server.protocol)) {
    const name = target.server.protocol === 'ftp' ? 'FTP' : 'FTPS';
    parts.push(`${name}, ${plural(connections ?? target.parallel, 'connection')}`);
  }
  return [`**${formatSeconds(outcome.durationMs)}**`, ...parts].join(' · ');
}

/**
 * Every change in a collapsed `diff` block (S07, S10): `+` new, `~` changed, `-` deleted, then
 * the kept files with their reason; counted without the kept ones, as the page does.
 */
function changesBlock(plan: Plan): string[] {
  const { uploads, writes, deletes } = changes(plan);
  const lines = [
    ...uploads.map(
      (op) =>
        `${op.reason === 'new' ? '+' : '~'} ${op.path}${op.reason === 'changed-on-server' ? `  ${changedOnServer}` : ''}`,
    ),
    ...writes.map((op) => `${op.reason === 'new' ? '+' : '~'} ${op.path}  from ${op.from}`),
    ...deletes.map((op) => `- ${op.path}${op.reason === 'not-in-build' ? `  ${notInBuild}` : ''}`),
    ...plan.kept.map((kept) => `  ${kept.path}  kept: ${keptReasons[kept.reason]}`),
  ];
  if (lines.length === 0) return [];
  const count = uploads.length + writes.length + deletes.length;
  return [collapsed(`Changes (${formatCount(count)})`, 'diff', lines)];
}

/** The links in the build that `allow: [symlinks]` skipped (spec #41 decision 28), collapsed. */
function skippedBlock(plan: Plan): string[] {
  if (plan.skipped.length === 0) return [];
  const head = `Skipped ${plural(plan.skipped.length, 'link')} in your build (sealup never follows a link)`;
  return [collapsed(head, '', plan.skipped)];
}

/** S20: the uploads that did not arrive, sizes in a column, in a plain block. */
function notUploadedBlock(run: PartialRun): string[] {
  if (run.missing.length === 0) return [];
  const width = Math.max(...run.missing.map((file) => file.path.length));
  const sizes = run.missing.map((file) => formatBytes(file.size));
  const sizeWidth = Math.max(...sizes.map((size) => size.length));
  const lines = run.missing.map(
    (file, i) => `${file.path.padEnd(width)}    ${(sizes[i] ?? '').padStart(sizeWidth)}`,
  );
  return [collapsed(`Not uploaded (${formatCount(run.missing.length)})`, '', lines)];
}

/**
 * `<details>` around a fenced block, cut after `summaryListLines` lines with a count of the
 * rest. The fence is longer than any backtick run in the lines, so no path can close it.
 */
function collapsed(summary: string, language: string, lines: readonly string[]): string {
  const shown = lines.slice(0, summaryListLines);
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`… ${formatCount(rest)} more (every change is in the log)`);
  const longest = Math.max(
    0,
    ...shown.flatMap((line) => line.match(/`+/g) ?? []).map((r) => r.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [
    `<details><summary>${summary}</summary>`,
    '',
    `${fence}${language}`,
    ...shown,
    fence,
    '',
    '</details>',
  ].join('\n');
}

function footer(version: string, slug?: Slug): string {
  const link =
    slug === undefined
      ? '[docs](https://sealup.dev)'
      : `[More: sealup.dev/e/${slug}](https://sealup.dev/e/${slug})`;
  return `<sub>sealup ${version} · ${link}</sub>`;
}
