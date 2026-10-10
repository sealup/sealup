// Numbers and layout of sealup's terminal output (decision 0024, the CLI page's goldens), as
// styled lines: the target block, the plan line, the dry run's lists, the progress line, the
// result. Pure (import rules, pure file): no node: import, no colour codes; the terminal
// reporter turns a style into colour, or drops it. The words of problems live in problems.ts,
// the sentences about the config file in config-words.ts.
//
// Layout rules kept here: two-space indent, the label column (`production  `, `host key    `),
// the right edge at column 72 for sizes, ` · ` between parts, a dim second line under a result.

import type {
  HostKeyCheck,
  KeptFile,
  Outcome,
  Plan,
  PlanOp,
  Progress,
  ServerCertificate,
  ServerUrl,
  Target,
  Timings,
} from '../contracts/index.ts';

/** The page's colour roles (green done, red failed, bold key phrase, dim secondary). */
export type Style =
  | 'green'
  | 'red'
  | 'bold'
  | 'dim'
  | 'boldGreen'
  | 'boldRed'
  /** A warning's `!` (decision 0024: yellow is a warning's colour). */
  | 'yellow'
  /** The DRY RUN label (decision 0024: yellow is the dry run's colour). */
  | 'inverseYellow';

type Segment = string | { readonly text: string; readonly style: Style };
/** One output line, without its line break. */
export type Line = readonly Segment[];

/** Right edge of sizes in plan lines and file lists (S07, S10). */
const rightEdge = 72;
/** No line passes this column (decision 0024 §2). */
const maxColumns = 80;
/** Width of the label column after the indent: `production` and `host key` padded to it. */
const labelWidth = 10;

export const style = (text: string, s: Style): Segment => ({ text, style: s });

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** 1024-based; KB without a decimal, MB and GB with one, none from 100 of a unit on. */
export function formatBytes(n: number): string {
  const { value, unit } = byteUnit(n);
  return `${value} ${unit}`;
}

interface ByteUnit {
  readonly value: string;
  readonly unit: 'B' | 'KB' | 'MB' | 'GB';
  readonly divisor: number;
  readonly decimals: number;
}

function byteUnit(n: number): ByteUnit {
  if (n < 1024) return { value: formatCount(n), unit: 'B', divisor: 1, decimals: 0 };
  const units = ['KB', 'MB', 'GB'] as const;
  let divisor = 1024;
  let unit = 0;
  while (n / divisor >= 1024 && unit < units.length - 1) {
    divisor *= 1024;
    unit++;
  }
  const decimals = unit === 0 || n / divisor >= 100 ? 0 : 1;
  return { value: (n / divisor).toFixed(decimals), unit: units[unit] ?? 'GB', divisor, decimals };
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `sftp://user@host:port/folder`: always with the port (R22). Never holds a secret. */
export function formatServer(server: ServerUrl): string {
  return `${server.protocol}://${server.user}@${server.host}:${server.port}${server.folder}`;
}

export function plural(n: number, word: string): string {
  return `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** `left` and `right` on one line, `right` ending at column 72 (at least two spaces between). */
export function aligned(left: string, right: string): Line {
  const gap = Math.max(2, rightEdge - left.length - right.length);
  return [`${left}${' '.repeat(gap)}${right}`];
}

/** `left` with `right` ending at column 72 (at least two spaces between). */
export function withRight(left: readonly Segment[], right: string): Line {
  const gap = Math.max(2, rightEdge - visible(left) - right.length);
  return [...left, `${' '.repeat(gap)}${right}`];
}

function segmentText(segment: Segment): string {
  return typeof segment === 'string' ? segment : segment.text;
}

/** How many columns a line takes (every character sealup prints is one column wide). */
function visible(line: Line): number {
  return line.reduce((n, segment) => n + segmentText(segment).length, 0);
}

function label(text: string): string {
  return `  ${text.padEnd(labelWidth)}  `;
}

/** The first line of the target block: name and full server URL. */
export function targetLines(target: Target): Line[] {
  return [targetLine(target.name, target.server)];
}

/** The target block's first line for a target known by its name and server only (keyscan). */
export function targetLine(name: string, server: ServerUrl): Line {
  return [`${label(name)}${formatServer(server)}`];
}

/** The target block's host key label, padded to the label column. */
export const hostKeyLabel = label('host key');

/** The key type as `ssh-keygen -l` names it (S17: `ED25519`). */
export function keyType(type: string): string {
  if (type === 'ssh-ed25519') return 'ED25519';
  if (type === 'ssh-rsa') return 'RSA';
  if (type === 'ssh-dss') return 'DSA';
  if (type.startsWith('ecdsa-')) return 'ECDSA';
  return type;
}

/** ` (line 17)`, or nothing when the place has no line. */
export function lineOf(place: { readonly line?: number }): string {
  return place.line === undefined ? '' : ` (line ${place.line})`;
}

/** ` line 4`, or nothing when the place has no line. */
export function lineWord(place: { readonly line?: number }): string {
  return place.line === undefined ? '' : ` line ${place.line}`;
}

/** The second line of the target block, then the blank line that closes the block. */
export function hostKeyLines(
  check: HostKeyCheck,
  target: Target | undefined,
  file: string,
): Line[] {
  if (check.state === 'certificate') {
    const how =
      check.check === 'refused' ? style('refused', 'boldRed') : style(check.check, 'green');
    return [...certificateLines(check.certificate, how), []];
  }
  return [hostKeyLine(check, target, file), []];
}

/**
 * FTPS's lines in place of the host key (spec #41 decision 10): the certificate's subject and how
 * it was checked (`how`), then its SHA-256, the value `tlsFingerprint` pins, under it.
 */
export function certificateLines(certificate: ServerCertificate, how: Segment): Line[] {
  return [
    [`${hostKeyLabel}certificate ${printable(certificate.subject)}  `, how],
    [`${' '.repeat(hostKeyLabel.length)}SHA-256 ${certificate.sha256}`],
  ];
}

/**
 * The target block's `transfer` line on `ssh://` (S12, 0034), under the host key line, then the
 * block's blank line: how changed files travel, and why not as an archive.
 */
export function transferLines(via: 'archive' | 'file-by-file', reason?: 'login-folder'): Line[] {
  const how =
    via === 'archive'
      ? 'changed files travel as one archive over SSH'
      : reason === 'login-folder'
        ? "file by file over SFTP (the login folder's name is not safe in a command)"
        : 'file by file over SFTP (no tar on the server)';
  return [[`${label('transfer')}${how}`], []];
}

function hostKeyLine(check: HostKeyCheck, target: Target | undefined, file: string): Line {
  const head = label('host key');
  switch (check.state) {
    case 'verified':
      return [`${head}${check.fingerprint}  `, style('verified', 'green')];
    case 'changed':
      // The received key, with no key type (S17, ruling 2).
      return [`${head}${check.received.fingerprint}  `, style('changed', 'boldRed')];
    case 'missing':
      return [
        head,
        style('missing', 'red'),
        `  no hostKey for ${target?.name ?? 'this target'} in ${fileName(file)}`,
      ];
    case 'not-checked':
      return [head, style('not checked', 'dim')];
    case 'none':
      return [head, style(noHostKey, 'dim')];
    case 'certificate':
      return [head, `certificate ${printable(check.certificate.subject)}`];
  }
}

/** The host key line of a protocol without one (S23). */
export const noHostKey = 'none (plain FTP has no host key)';

/**
 * The notice a first deploy gets, above its plan line or its dry run list (S07); with the full
 * mirror's deletes, what it deletes (decision 0030).
 */
function firstDeployNotice(plan: Plan): Line[] {
  if (!plan.firstDeploy) return [];
  const mirrored = changes(plan).deletes.some((op) => op.reason === 'not-in-build');
  const words = mirrored
    ? ' files not in your build are deleted (mirror).'
    : ' existing files stay. sealup only ever deletes files it uploaded.';
  return [['  ', { text: 'First deploy:', style: 'bold' }, words]];
}

/** The notice of a first deploy, then the one plan line: counts, then bytes (S07, S08). */
export function planLines(plan: Plan): Line[] {
  // Nothing to do: no plan line, the result says it (S09).
  if (plan.ops.length === 0 && !plan.firstDeploy) return [];
  const { uploads, writes, deletes } = changes(plan);
  // Uploads are always counted (S07: `5,862 to upload` alone); writes, deletes and unchanged
  // when any. The bytes are the uploads' only: a secret's size is never shown.
  const counts = [`${formatCount(uploads.length)} to upload`];
  if (writes.length > 0) counts.push(`${formatCount(writes.length)} to write`);
  if (deletes.length > 0) counts.push(`${formatCount(deletes.length)} to delete`);
  if (plan.unchanged > 0) counts.push(`${formatCount(plan.unchanged)} unchanged`);
  const lines = firstDeployNotice(plan);
  lines.push(aligned(`  ${counts.join(' · ')}`, formatBytes(plan.bytes)));
  return lines;
}

type Upload = Extract<PlanOp, { op: 'upload' }>;
type Write = Extract<PlanOp, { op: 'write' }>;
type Delete = Extract<PlanOp, { op: 'delete' }>;

/**
 * The uploads and the writes (new ones first, then changed ones) and the deletes (those that left
 * the build first, then the mirror's), each in plan order.
 */
export function changes(plan: Plan): { uploads: Upload[]; writes: Write[]; deletes: Delete[] } {
  const uploads = plan.ops.filter((op): op is Upload => op.op === 'upload');
  const writes = plan.ops.filter((op): op is Write => op.op === 'write');
  const deletes = plan.ops.filter((op): op is Delete => op.op === 'delete');
  return {
    uploads: [
      ...uploads.filter((op) => op.reason === 'new'),
      ...uploads.filter((op) => op.reason === 'changed'),
      ...uploads.filter((op) => op.reason === 'changed-on-server'),
    ],
    writes: [
      ...writes.filter((op) => op.reason === 'new'),
      ...writes.filter((op) => op.reason === 'changed'),
    ],
    deletes: [
      ...deletes.filter((op) => op.reason === 'left-build'),
      ...deletes.filter((op) => op.reason === 'not-in-build'),
    ],
  };
}

/** The note of a delete the full mirror found (decision 0030). */
export const notInBuild = 'not in the build';

/** The note of an upload the server check found changed (spec #41 decision 26). */
export const changedOnServer = 'changed on the server';

/** Why a recorded file is kept, after its path (the dry run, the job summary). */
export const keptReasons: Readonly<Record<KeptFile['reason'], string>> = {
  excluded: 'excluded now, never deleted',
  // allow: [symlinks] (spec #41 decision 28): the path is a server link, or behind one.
  link: 'a link on the server, never deleted',
};

/**
 * Every change of a plan, one file a line, with server paths (relative to the target folder):
 * `+` new and `~` changed with their sizes at column 72, `-` deleted, `·` kept with its reason
 * (S10). `heads` adds the dry run's "Would …" line above each group.
 */
function changeLines(plan: Plan, heads: boolean): Line[] {
  const { uploads, writes, deletes } = changes(plan);
  const lines: Line[] = [];
  if (uploads.length > 0) {
    if (heads) {
      const head = `Would upload ${plural(uploads.length, 'file')}`;
      lines.push(withRight(['  ', style(head, 'bold')], formatBytes(plan.bytes)));
    }
    for (const op of uploads) {
      const symbol = op.reason === 'new' ? style('+', 'green') : '~';
      const note = op.reason === 'changed-on-server' ? { note: changedOnServer } : {};
      lines.push(...fileLines(symbol, op.path, { right: formatBytes(op.size), ...note }));
    }
  }
  // A file written from a secret: its variable's name, never its content or size (R17).
  if (writes.length > 0) {
    if (heads) {
      const head = `Would write ${plural(writes.length, 'file')} from secrets`;
      lines.push(['  ', style(head, 'bold')]);
    }
    for (const op of writes) {
      const symbol = op.reason === 'new' ? style('+', 'green') : '~';
      lines.push(...fileLines(symbol, op.path, { note: `from ${op.from}` }));
    }
  }
  const groups = [
    [
      deletes.filter((op) => op.reason === 'left-build'),
      'sealup uploaded them; they are no longer in your build',
    ],
    [deletes.filter((op) => op.reason === 'not-in-build'), 'mirror: sealup did not upload them'],
  ] as const;
  for (const [group, why] of groups) {
    if (group.length === 0) continue;
    if (heads) {
      const head: Line = ['  ', style(`Would delete ${plural(group.length, 'file')}`, 'bold')];
      const note = style(`(${why})`, 'dim');
      // On the head line as on the page (S10); under it when a count of 10 or more would push
      // the line past 80 columns.
      const together: Line = [...head, '  ', note];
      lines.push(...(visible(together) <= maxColumns ? [together] : [head, ['    ', note]]));
    }
    for (const op of group) {
      const note = op.reason === 'not-in-build' ? { note: notInBuild } : {};
      lines.push(...fileLines(style('-', 'red'), op.path, note));
    }
  }
  if (plan.kept.length > 0) {
    if (heads) lines.push(['  ', style(`Would keep ${plural(plan.kept.length, 'file')}`, 'bold')]);
    for (const kept of plan.kept) {
      lines.push(...fileLines('·', kept.path, { note: keptReasons[kept.reason] }));
    }
  }
  return lines;
}

/**
 * The links in the build that `allow: [symlinks]` skips (spec #41 decision 28): a head, then one
 * a line, from the config folder as the build has them. None when there are none.
 */
export function skippedLines(plan: Plan, verb: 'Skipped' | 'Would skip'): Line[] {
  if (plan.skipped.length === 0) return [];
  const head = `${verb} ${plural(plan.skipped.length, 'link')} in your build`;
  return [
    ['  ', style(head, 'bold'), '  ', style('(sealup never follows a link)', 'dim')],
    ...plan.skipped.flatMap((link) => fileLines('·', link, {})),
  ];
}

/** `-v` on a real run: the file list under the plan line, as in the dry run. */
export function verboseLines(plan: Plan): Line[] {
  return changeLines(plan, false);
}

/** The dry run's label, yellow inverse, then its words (S10: one space, then ` DRY RUN `). */
export function dryRunLabel(...words: Segment[]): Line {
  return [' ', style(' DRY RUN ', 'inverseYellow'), ' ', ...words];
}

/** The first line of a dry run, above the target block. */
export function dryRunStartLines(target: Target): Line[] {
  return [dryRunLabel(`nothing will change on ${target.name}`)];
}

/** A dry run's plan: every change, with "would" verbs, then the unchanged count (S10). */
export function dryRunPlanLines(plan: Plan): Line[] {
  const lines = firstDeployNotice(plan);
  const listed = changeLines(plan, true);
  lines.push(...(listed.length > 0 ? listed : [['  Nothing would change.']]));
  lines.push(...skippedLines(plan, 'Would skip'));
  if (plan.unchanged > 0) lines.push([`  ${formatCount(plan.unchanged)} unchanged`]);
  return lines;
}

/** The last lines of a dry run: the label again, and the exact command that applies it. */
export function dryRunEndLines(command: string): Line[] {
  return [[], dryRunLabel('nothing was changed. To apply: ', style(command, 'bold'))];
}

/** `-v`: where the time went, under the result (spec.md §4.2). */
export function timingLines(timings: Timings): Line[] {
  const parts = (['connect', 'scan', 'compare', 'transfer'] as const).map(
    (phase) => `${phase} ${formatSeconds(timings[phase])}`,
  );
  return [['    ', style([...parts, ...reconnectTime(timings)].join(' · '), 'dim')]];
}

/** The reconnect's part of a timing line (S11): none when the run never lost its connection. */
export function reconnectTime(timings: Timings): string[] {
  return timings.reconnect === undefined ? [] : [`reconnect ${formatSeconds(timings.reconnect)}`];
}

/** `once`, `twice`, `3 times`: how often something happened. */
export function times(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${formatCount(n)} times`;
}

/** Where a path starts in a file list: `    + `. */
const pathColumn = 6;

/**
 * One file of a list: `    + path`, then a note after two spaces, then its size ending at
 * column 72 (either or both). A path is never shortened (a review must show the real one): one
 * too long for its line goes on over more lines, indented under its start and broken after a `/`
 * where it can, so no line passes 80 columns.
 */
export function fileLines(
  symbol: Segment,
  path: string,
  tail: { readonly right?: string; readonly note?: string },
): Line[] {
  const room = maxColumns - pathColumn;
  const after = [tail.note, tail.right].reduce(
    (width, part) => width + (part === undefined ? 0 : part.length + 2),
    0,
  );
  const pieces = breakPath(path, room, room - after);
  const lines = pieces.map((piece, i): Segment[] =>
    i === 0 ? ['    ', symbol, ' ', piece] : ['      ', piece],
  );
  const last = lines.pop() ?? [];
  const noted = tail.note === undefined ? last : [...last, '  ', style(tail.note, 'dim')];
  lines.push(tail.right === undefined ? noted : [...withRight(noted, tail.right)]);
  return lines;
}

/** `path` in pieces of at most `room` characters, the last one at most `lastRoom`. */
function breakPath(path: string, room: number, lastRoom: number): string[] {
  const pieces: string[] = [];
  let rest = path;
  while (rest.length > lastRoom) {
    const limit = Math.min(room, rest.length - 1);
    const slash = rest.lastIndexOf('/', limit - 1) + 1;
    const cut = slash > 0 ? slash : Math.min(limit, lastRoom);
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/** Cells of the progress bar (page: BAR_CELLS). */
const barCells = 30;
/** Seconds padded to this width, so the line keeps its length while it runs (up to 99.9 s). */
const secondsWidth = 4;

/**
 * The progress line (page code `progressText`): bar, files, bytes in the total's unit, seconds.
 * Done counts are padded to the totals' widths, so only the bar and the numbers move. The gaps
 * are three spaces, or two when three would pass 80 columns.
 */
export function progressLine(progress: Progress, icon: '↑' | '↓' = '↑'): Line {
  const fraction = progress.totalFiles === 0 ? 1 : progress.files / progress.totalFiles;
  const filled = Math.round(Math.min(1, fraction) * barCells);
  const { files, bytes, seconds } = progressParts(progress);
  const fixed = 4 + barCells + 3 + files.length + bytes.length + seconds.length;
  const gap = fixed + 6 <= maxColumns ? '   ' : '  ';
  return [
    '  ',
    style(icon, 'bold'),
    ' ',
    style('━'.repeat(filled), 'green'),
    style('─'.repeat(barCells - filled), 'dim'),
    `   ${files}${gap}${bytes}${gap}`,
    style(seconds, 'dim'),
  ];
}

/**
 * The numbers of a progress line: files and bytes done of the totals (bytes in the total's unit),
 * each padded to its total's width, and the seconds padded to four characters, so the columns
 * stay put from one line to the next.
 */
export function progressParts(progress: Progress): {
  readonly files: string;
  readonly bytes: string;
  readonly seconds: string;
} {
  const total = formatCount(progress.totalFiles);
  const files = `${formatCount(progress.files).padStart(total.length)} / ${total} files`;
  const unit = byteUnit(progress.totalBytes);
  const done =
    unit.unit === 'B'
      ? formatCount(progress.bytes)
      : (progress.bytes / unit.divisor).toFixed(unit.decimals);
  const bytes = `${done.padStart(unit.value.length)} / ${unit.value} ${unit.unit}`;
  const seconds = `${(progress.elapsedMs / 1000).toFixed(1).padStart(secondsWidth)} s`;
  return { files, bytes, seconds };
}

/** The result of a run that ended well (S07); `afterPlan` adds the blank line before it. */
export function resultLines(outcome: Outcome, target: Target, afterPlan: boolean): Line[] {
  const lines: Line[] = afterPlan ? [[]] : [];
  const time = formatSeconds(outcome.durationMs);
  const [headline, rest] = resultWords(outcome, target.name);
  lines.push(['  ', style(`✓ ${headline}:`, 'boldGreen'), ` ${rest} in ${time}.`]);
  // The dim second line: the extras, then the site address, joined with ` · ` (S08).
  const extras: string[] = [];
  if (outcome.deleted > 0 && !onlyDeleted(outcome)) {
    extras.push(`${plural(outcome.deleted, 'old file')} removed`);
  }
  // A flaky host, said quietly (S11).
  const reconnects = outcome.reconnects ?? 0;
  if (reconnects > 0) extras.push(`reconnected ${times(reconnects)}`);
  if (target.url !== undefined) extras.push(target.url);
  if (extras.length > 0) lines.push(['    ', style(extras.join(' · '), 'dim')]);
  return lines;
}

/** A run that removed old files and delivered none. */
function onlyDeleted(outcome: Outcome): boolean {
  return outcome.status !== 'unchanged' && outcome.uploaded + outcome.written === 0;
}

/**
 * The result of a run that ended well, as the result line and the summary's heading say it:
 * the headline, and what it did to `name` (the time follows).
 */
export function resultWords(outcome: Outcome, name: string): [string, string] {
  if (outcome.status === 'unchanged') {
    return ['Already up to date', `${plural(outcome.unchanged, 'file')} checked on ${name}`];
  }
  if (onlyDeleted(outcome)) {
    return ['Cleaned up', `${plural(outcome.deleted, 'old file')} removed from ${name}`];
  }
  // Files written from a secret are delivered too.
  return [
    'Sealed up and delivered',
    `${plural(outcome.uploaded + outcome.written, 'file')} to ${name}`,
  ];
}

export function fileName(path: string): string {
  return path.slice(lastSeparator(path) + 1);
}

export function folderOf(path: string): string {
  return path.slice(0, Math.max(lastSeparator(path), 0));
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/** A name as it can be printed: control characters as `\xNN`, so a line stays one line. */
export function printable(name: string): string {
  return name.replace(/\p{Cc}/gu, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `\\x${code.toString(16).padStart(2, '0')}`;
  });
}
