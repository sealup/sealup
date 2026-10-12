// The texts that are not runs: help, the version, `sealup` alone (S01, S05), `check` (S06),
// `keyscan` (S04) and `init` (S02) steps, a log form's first lines (GitHub's masks, then the
// version line) and GitHub's warning for a file the action could not write.

import type { CheckReport, Secret } from '../contracts/index.ts';
import { secretForms } from '../secret/index.ts';
import { type CertificateStep, certificateScanLines } from './certificate-scan.ts';
import { checkAnnotations, checkLines } from './check.ts';
import { type Line, plural } from './format.ts';
import { type HelpTopic, helpLines } from './help.ts';
import { type InitStep, initLines } from './init.ts';
import { type KeyscanStep, keyscanLines } from './keyscan.ts';
import { command } from './log.ts';
import type { TerminalOptions } from './reporters.ts';
import {
  annotationCommands,
  type Form,
  type Out,
  shellWord,
  writeCommand,
  writeLines,
} from './sink.ts';

/**
 * `sealup --help` and `sealup help [topic]`: the page's screens, listing only what works in this
 * version (ruling 8, spec #24 decision 13); help.ts holds them.
 */
export function printHelp(out: Out, topic?: HelpTopic): void {
  writeLines(out, helpLines(topic));
}

/**
 * GitHub's warning that a file sealup writes for the runner (the action's outputs, its plan file)
 * could not be written: one workflow command through the one sink, escaped and redacted like
 * every other line. It names the error's code (EACCES, EISDIR), never its message.
 */
export function printNotWritten(out: Out, title: string, error: unknown): void {
  const code = (error as { code?: unknown } | undefined)?.code;
  const why = typeof code === 'string' ? code : 'an error';
  writeCommand(out, command('warning', { title }, `sealup could not write it (${why}).`));
}

/**
 * The first lines of a log form (0024 §9). In GitHub's, an `::add-mask::` line for each form of
 * each secret (R2), before any other byte: these lines are the one place sealup writes a secret,
 * so they skip redaction by name, here, and nowhere else. The values read from a variable that a
 * public repo hides (decision 0045) are masked the same way. Then `sealup <version> · <command>
 * [target]` (spec #24 decision 27), so an old log says which version ran: never a flag or a
 * value typed on the command line (cli gives only a command it knows and a target name).
 * Nothing on a terminal.
 */
export function printLogStart(
  out: Out,
  form: Form,
  start: {
    readonly version: string;
    readonly command?: string;
    readonly target?: string;
    readonly secrets: readonly Secret[];
    /** Values masked in GitHub's form only, after the secrets (decision 0045). */
    readonly hidden?: readonly string[];
  },
): void {
  if (form === 'terminal') return;
  if (form === 'github') writeMasks(out, secretForms(start.secrets, start.hidden));
  const words = [start.command, start.target].filter((word) => word !== undefined);
  const typed = words.length === 0 ? '' : ` · ${words.map(shellWord).join(' ')}`;
  writeLines(out, [[`sealup ${start.version}${typed}`]]);
}

/** One `::add-mask::` line for each value, as it is: never through redaction. */
function writeMasks(out: Out, values: readonly string[]): void {
  for (const value of values) out.write(`${command('add-mask', {}, value)}\n`);
}

/**
 * GitHub's mask lines for what a server showed of itself during the run, for a target that hides
 * a part (decision 0045): a changed host key, a certificate. They come before the first line that
 * shows it, as the run learns it only once connected. Never a secret: those mask first (R2).
 */
export function printLateMasks(out: Out, values: readonly string[]): void {
  writeMasks(out, secretForms([], values));
}

/**
 * `sealup` alone without a config (S01): where sealup looked, and the command that starts the
 * setup. `repo`: it searched up to the repo root, not this folder only.
 */
export function printNoConfig(
  out: Out,
  facts: { readonly version: string; readonly repo: boolean },
): void {
  writeLines(out, [
    [`  sealup ${facts.version} · no sealup.yml found`],
    [],
    [
      facts.repo
        ? '  Looked in this folder and in each folder above it, up to the repo root.'
        : '  Looked in this folder.',
    ],
    [],
    ['  Set up this project:  ', { text: 'sealup init', style: 'bold' }],
    ['  ', { text: 'It asks for the server address and writes the rest.', style: 'dim' }],
    [],
    ['  All commands:         sealup help'],
  ]);
}

/**
 * `sealup` alone with a config (S05): the exact commands of this project, with its target names
 * (none for the only target), each deploy line naming the target's site (its `url`, else its
 * host), and the pull block when a target has pull entries. `config` is the file as shown; `args` the flags each command repeats (`-c <file>`).
 */
export function printProjectHelp(
  out: Out,
  facts: {
    readonly version: string;
    readonly config: string;
    readonly targets: readonly {
      readonly name: string;
      readonly site: string | undefined;
      /** Its pull entries, server side then local side, as written (`.`: the target folder). */
      readonly pulls: readonly (readonly [remote: string, local: string])[];
    }[];
    readonly args: readonly string[];
  },
): void {
  const { targets } = facts;
  const one = targets.length === 1;
  const command = (...words: string[]): string =>
    ['sealup', ...words, ...facts.args].map(shellWord).join(' ');
  const deploys = targets.map(({ name, site }) => [
    command('deploy', ...(one ? [] : [name])),
    site === undefined ? 'send changes' : `send changes to ${site}`,
  ]);
  const [first] = targets;
  const dryRun = command(
    'deploy',
    '--dry-run',
    ...(one || first === undefined ? [] : [first.name]),
  );
  const check = command('check');
  // The pull block names the first target with pull entries, as the page's S05 does.
  const puller = targets.find(({ pulls }) => pulls.length > 0);
  const pull = puller === undefined ? '' : command('pull', ...(one ? [] : [puller.name]));
  const width = Math.max(
    30,
    ...[...deploys.map(([c]) => c ?? ''), dryRun, check, pull].map((c) => c.length + 3),
  );
  const row = (left: string, right: string): Line => [`    ${left.padEnd(width)}${right}`];
  const names = targets.map(({ name }) => name).join(', ');
  writeLines(out, [
    [`  sealup ${facts.version} · ${facts.config} · ${plural(targets.length, 'target')}: ${names}`],
    [],
    ['  ', { text: 'Deploy', style: 'bold' }],
    ...deploys.map(([left = '', right = '']) => row(left, right)),
    row(dryRun, 'dry run: list every change, change nothing'),
    [],
    ...(puller === undefined
      ? []
      : [
          ['  ', { text: 'Copy user uploads to this machine', style: 'bold' }] satisfies Line,
          ...puller.pulls.map(([remote, local], i) =>
            row(i === 0 ? pull : '', `${remote} → ${local}`),
          ),
          [],
        ]),
    ['  ', { text: 'Check', style: 'bold' }],
    row(check, 'sealup.yml and its variables, offline'),
    [],
    ['  All commands, config keys and exit codes: sealup help'],
  ]);
}

/**
 * `sealup check` (S06) on stderr, after the log's first lines: the checks and the verdict, then
 * in GitHub one annotation per warning (or the deciding problem's, when no target is ready).
 */
export function printCheck(
  out: Out,
  report: CheckReport,
  options: Pick<TerminalOptions, 'form' | 'quiet' | 'applyArgs' | 'workspace'> = {},
): void {
  const form = options.form ?? 'terminal';
  const lines = checkLines(report, {
    quiet: options.quiet === true,
    ci: form === 'github',
    applyArgs: (options.applyArgs ?? []).map(shellWord),
  });
  writeLines(out, lines, form);
  if (form !== 'github') return;
  for (const text of annotationCommands(checkAnnotations(report), options.workspace)) {
    writeCommand(out, text);
  }
}

/**
 * One step of `sealup keyscan` (S04) on stderr, after the log's first lines: the target block,
 * the key and what its state calls for, the key saved or the line to paste (keyscan.ts).
 */
export function printKeyscan(out: Out, form: Form, step: KeyscanStep): void {
  writeLines(out, keyscanLines(step, shellWord), form);
}

/**
 * One step of `sealup keyscan` on an `ftps://` target (spec #41 decision 12), after the target
 * line: the certificate and what its state calls for (certificate-scan.ts).
 */
export function printCertificateScan(out: Out, form: Form, step: CertificateStep): void {
  writeLines(out, certificateScanLines(step, shellWord), form);
}

/** One step of `sealup init`'s output (S02, init.ts). */
export function printInit(out: Out, form: Form, step: InitStep): void {
  writeLines(out, initLines(step), form);
}

/** `sealup --version`: the version alone, for scripts. */
export function printVersion(out: Out, version: string): void {
  writeLines(out, [[version]]);
}
