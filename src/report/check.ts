// The words of `sealup check` (S06, spec #24 decision 14): one line per check in the page's
// order (the file, the targets, the upload folders, the variables, the host keys), then the
// verdict. Variables by name and where they came from, never a value (R6). Without a name, a
// target's problem is a `!` warning for it; with a name (or one target) it is a `✗`. In GitHub,
// each warning is also a `::warning` annotation, at the config line when there is one. Pure
// (import rules, pure file): no node: import.
//
// Where later checks go: a `write` entry's secret is one more variable (config reads it; the
// variables line needs nothing new); a `pull` entry's local folder gets its own line after the
// upload folders (the pull ticket).

import type {
  CheckReport,
  ConfigIssue,
  Problem,
  TargetCheck,
  UploadCheck,
  VariableSource,
} from '../contracts/index.ts';
import type { Annotation } from './annotations.ts';
import { annotationsOf } from './annotations.ts';
import { fileName, folderOf, type Line, plural, style } from './format.ts';
import { explain, problemLines } from './problems.ts';

export interface CheckWords {
  /** `-q`: the warnings and errors and the verdict only. */
  readonly quiet: boolean;
  /** GitHub's words where the fix differs in CI (the verdict's problem). */
  readonly ci: boolean;
  /** The flags the dry run's command repeats (`-c <file>`). */
  readonly applyArgs: readonly string[];
}

/** A missing variable and the targets that need it, at the first place that reads it. */
interface Missing {
  readonly issue: ConfigIssue;
  readonly targets: string[];
}

/** The lines of a check: the checks, a blank line, the verdict. */
export function checkLines(report: CheckReport, words: CheckWords): Line[] {
  const { targets } = report;
  const single = report.named || targets.length === 1;
  const ok = (...text: Line): Line => ['  ', style('✓', 'green'), ' ', ...text];
  const flag = (text: string): Line =>
    single ? ['  ', style('✗', 'boldRed'), ' ', text] : ['  ', style('!', 'yellow'), ' ', text];
  const lines: Line[] = [];
  const passed = (line: Line): void => {
    if (!words.quiet) lines.push(line);
  };

  passed(ok(`${fileName(report.configFile)} is valid`));
  const names = targets.map(({ name }) => name);
  passed(
    ok(
      report.named
        ? `Target: ${names.join(', ')}`
        : `${plural(names.length, 'target')}: ${names.join(', ')}`,
    ),
  );

  const uploads = sentUploads(targets);
  if (uploads.length > 0) {
    const files = uploads.some((upload) => upload.kind === 'file');
    passed(
      ok(`${files ? 'Uploads' : 'Upload folders'} exist: ${uploads.map(uploadText).join(', ')}`),
    );
  }
  for (const target of targets) {
    const { problem } = target;
    if (problem === undefined || missingOf(problem) !== undefined) continue;
    if (problem.code === 'host-key-missing') continue;
    const title = explain(problem, target.target, report.configFile).title;
    lines.push(flag(single ? title : `${target.name}: ${title}`));
  }
  // Ruling 2: a pull: folder the mirror would delete is a warning, never a stop.
  for (const target of targets) {
    for (const { pull, exclude } of target.mirroredPulls ?? []) {
      const text = `${mirrorDeletes(pull.remote)}: no exclude covers it.`;
      lines.push(['  ', style('!', 'yellow'), ' ', single ? text : `${target.name}: ${text}`]);
      const fix = `To keep it, add ${exclude} to exclude in ${fileName(report.configFile)}.`;
      lines.push(['    ', style(fix, 'dim')]);
    }
  }

  const set = variablesSet(targets);
  if (set.length > 0) passed(ok('Variables set: ', ...sourcesText(set, report)));
  for (const missing of missingVariables(targets)) {
    lines.push(flag(missingText(missing, single, targets.length)));
  }

  const logins = loginText(targets);
  if (logins !== undefined) passed(ok(`Login: ${logins}`));

  const saved = targets.filter((target) => target.hostKey === 'saved').map(({ name }) => name);
  if (saved.length > 0) {
    passed(ok(`Host key${saved.length === 1 ? '' : 's'} saved for ${and(saved)}`));
  }
  for (const target of targets.filter(({ hostKey }) => hostKey === 'missing')) {
    lines.push(flag(`No host key saved for ${target.name}. Run: sealup keyscan ${target.name}`));
  }

  // Quiet with nothing to warn about: the verdict alone, no blank line before it.
  if (lines.length > 0) lines.push([]);
  lines.push(...verdict(report, words));
  return lines;
}

/** Ready: which targets, what the others need, the dry run to try. None ready: its problem. */
function verdict(report: CheckReport, words: CheckWords): Line[] {
  const ready = report.targets.filter(({ problem }) => problem === undefined);
  const [first] = report.targets;
  if (ready.length === 0 || first === undefined) {
    const problem = first?.problem;
    if (problem === undefined) return [];
    return problemLines(problem, first?.target, report.configFile, words.ci);
  }
  const others = report.targets
    .filter(({ problem }) => problem !== undefined)
    .map((target) => ` ${target.name} ${needs(target)}`);
  const name = report.named || report.targets.length > 1 ? [ready[0]?.name ?? ''] : [];
  const dryRun = ['sealup', 'deploy', '-n', ...name, ...words.applyArgs].join(' ');
  const lines: Line[] = [
    [
      '  ',
      style(`✓ Ready to deploy to ${and(ready.map(({ name }) => name))}.`, 'boldGreen'),
      others.join(''),
    ],
  ];
  if (!words.quiet) {
    lines.push([
      '    ',
      style(`Checked offline. A dry run also checks the server: ${dryRun}`, 'dim'),
    ]);
  }
  return lines;
}

/** What a target that is not ready needs, as the end of a sentence. */
function needs(target: TargetCheck): string {
  const { problem } = target;
  const missing = problem === undefined ? undefined : missingOf(problem);
  if (missing !== undefined) {
    return `needs ${and(missing.map((issue) => issue.variable ?? ''))} first.`;
  }
  if (problem?.code === 'host-key-missing') return 'needs a host key first.';
  if (target.exitCode === 6) return 'is stopped by a safety net.';
  return 'has a config problem.';
}

/** The variable-not-set issues of a problem made of nothing else, or undefined. */
function missingOf(problem: Problem): ConfigIssue[] | undefined {
  if (problem.code !== 'config') return undefined;
  const { issues } = problem;
  if (issues.length === 0 || issues.some(({ code }) => code !== 'variable-not-set'))
    return undefined;
  return [...issues];
}

/** Each missing variable once, with every target that needs it, in the order found. */
function missingVariables(targets: readonly TargetCheck[]): Missing[] {
  const found = new Map<string, Missing>();
  for (const target of targets) {
    const issues = target.problem === undefined ? undefined : missingOf(target.problem);
    for (const issue of issues ?? []) {
      const name = issue.variable ?? '';
      const known = found.get(name);
      if (known === undefined) found.set(name, { issue, targets: [target.name] });
      else if (!known.targets.includes(target.name)) known.targets.push(target.name);
    }
  }
  return [...found.values()];
}

/** S06: `STAGING_KEY is not set. Only staging needs it: targets.staging.privateKey`. */
function missingText(missing: Missing, single: boolean, checked: number): string {
  const { issue, targets } = missing;
  const name = issue.variable ?? '';
  if (single || targets.length === checked) return `${name} is not set: ${issue.keyPath}`;
  return `${name} is not set. ${onlyText(targets)}: ${issue.keyPath}`;
}

function onlyText(targets: readonly string[]): string {
  return `Only ${and(targets)} need${targets.length === 1 ? 's' : ''} it`;
}

/** The variables set, each once, in the order the targets read them. */
function variablesSet(targets: readonly TargetCheck[]): VariableSource[] {
  const set = new Map<string, VariableSource>();
  for (const target of targets) {
    for (const variable of target.variables) {
      if (!set.has(variable.name)) set.set(variable.name, variable);
    }
  }
  return [...set.values()];
}

/** `A, B  (from sealup.env)`, one group per source, the source dim. */
function sourcesText(set: readonly VariableSource[], report: CheckReport): Line {
  const envFile =
    fileName(report.envFile) === 'sealup.env' &&
    folderOf(report.envFile) === folderOf(report.configFile)
      ? 'sealup.env'
      : report.envFile;
  const groups = (['env-file', 'environment'] as const)
    .map((from) => ({ from, names: set.filter((v) => v.from === from).map((v) => v.name) }))
    .filter(({ names }) => names.length > 0);
  const line: (string | ReturnType<typeof style>)[] = [];
  groups.forEach(({ from, names }, i) => {
    if (i > 0) line.push(', ');
    const source = from === 'env-file' ? envFile : 'the environment';
    line.push(`${names.join(', ')}  `, style(`(from ${source})`, 'dim'));
  });
  return line;
}

/**
 * How the targets log in (decision 0033), grouped in the order first named:
 * `production and staging with a password`, `production with a password, staging with a
 * private key`. Undefined when no target's login is known.
 */
function loginText(targets: readonly TargetCheck[]): string | undefined {
  const groups = new Map<'password' | 'private-key', string[]>();
  for (const { name, login } of targets) {
    if (login === undefined) continue;
    groups.set(login, [...(groups.get(login) ?? []), name]);
  }
  if (groups.size === 0) return undefined;
  const words = { password: 'a password', 'private-key': 'a private key' } as const;
  return [...groups].map(([login, names]) => `${and(names)} with ${words[login]}`).join(', ');
}

/** The upload entries that send something, each once, in config order. */
function sentUploads(targets: readonly TargetCheck[]): UploadCheck[] {
  const seen = new Map<string, UploadCheck>();
  for (const target of targets) {
    for (const upload of target.uploads ?? []) {
      const key = `${upload.kind}:${upload.local}`;
      if (!seen.has(key) && (upload.kind === 'file' || upload.files > 0)) seen.set(key, upload);
    }
  }
  return [...seen.values()];
}

function uploadText(upload: UploadCheck): string {
  if (upload.kind === 'file') return upload.local;
  return `${upload.local === '' ? '.' : upload.local}/ (${plural(upload.files, 'file')})`;
}

/** What a `pull:` folder under a mirrored mapping risks (decision 0030). */
function mirrorDeletes(folder: string): string {
  return `The mirror deletes the pull: folder ${folder}`;
}

/** `a`, `a and b`, `a, b and c`. */
function and(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * GitHub's annotations of a check: each warning (a target's problem, a missing variable) as a
 * `::warning`, at its config line when there is one; when no target is ready, the deciding
 * problem's own annotations, as an error.
 */
export function checkAnnotations(report: CheckReport): Annotation[] {
  const { targets } = report;
  const single = report.named || targets.length === 1;
  const ready = targets.some(({ problem }) => problem === undefined);
  const [first] = targets;
  const deciding = ready ? undefined : first;
  const found: Annotation[] = [];
  const level = single ? 'error' : 'warning';
  for (const missing of missingVariables(targets)) {
    if (deciding !== undefined && missing.targets.includes(deciding.name)) continue;
    const { issue } = missing;
    const name = issue.variable ?? '';
    const message =
      single || missing.targets.length === targets.length
        ? `${issue.keyPath} reads $\{${name}}, which is not set.`
        : `${onlyText(missing.targets)}: ${issue.keyPath}.`;
    found.push({
      level,
      title: `${name} not set`,
      message,
      file: issue.file,
      ...(issue.line === undefined ? {} : { line: issue.line }),
    });
  }
  for (const target of targets) {
    const { problem } = target;
    if (problem === undefined || target === deciding || missingOf(problem) !== undefined) continue;
    for (const annotation of annotationsOf(problem, target.target, report.configFile)) {
      found.push({ ...annotation, level, title: `${target.name}: ${annotation.title}` });
    }
  }
  if (deciding?.problem !== undefined) {
    found.push(...annotationsOf(deciding.problem, deciding.target, report.configFile));
  }
  for (const target of targets) {
    for (const { pull, exclude } of target.mirroredPulls ?? []) {
      found.push({
        level: 'warning',
        title: 'Pull folder not excluded',
        message: `${mirrorDeletes(pull.remote)}. To keep it, exclude ${exclude}.`,
        file: pull.place.file,
        ...(pull.place.line === undefined ? {} : { line: pull.place.line }),
      });
    }
  }
  return found;
}
