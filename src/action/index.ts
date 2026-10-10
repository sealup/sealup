// action: the GitHub action's entry (decision 0014, spec #24 decisions 33, 34).
//
// Decision hidden: how the runner hands over inputs (INPUT_* variables) and takes outputs (the
// delimiter form in the file GITHUB_OUTPUT names), where the plan file goes (RUNNER_TEMP).
//
// Interface: runAction(env, io) returns sealup's exit code. It maps the inputs to
// `deploy [target] [-n] [-c <config>]` and runs cli's main() in the same process, in
// `working-directory`, which must be inside GITHUB_WORKSPACE (else exit 2). `bin.ts` is the
// action bundle's entry (`dist/action.mjs`): it wires the real process and transport.
//
// Invariants: no `@actions/*` package; secrets never come through inputs (0014). Every output is
// read from the run's `--json` object, which report has redacted. The exit code is main()'s,
// whatever happens to the outputs: a file sealup cannot write gets a warning, not a failure.
//
// Must never know: the words of the log (report words its warnings), the plan rules, ssh2.

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { type CliIo, main } from '../cli/index.ts';
import type { Env } from '../config/index.ts';
import type { Problem } from '../contracts/index.ts';
import { staysInside } from '../paths/index.ts';
import { printNotWritten } from '../report/index.ts';

/** What runAction needs from the process: main()'s io, less what the action decides itself. */
export type ActionIo = Omit<
  CliIo,
  | 'cwd'
  | 'stdoutIsTTY'
  | 'stdin'
  | 'stdinIsTTY'
  | 'json'
  | 'refuse'
  | 'scanHostKey'
  | 'scanCertificate'
>;

/** No keyboard in a runner: CI never asks a question (the picker needs a terminal). */
const noKeyboard: CliIo['stdin'] = {
  open: () => undefined,
  read: () => Promise.resolve(undefined),
  close: () => undefined,
};

/** The action runs `deploy` only: it never scans a host key (`keyscan`, #31). */
const noScan: CliIo['scanHostKey'] = () =>
  Promise.reject(new Error('the action runs deploy only: it never scans a host key'));

/** The `--json` object's fields the outputs are read from (src/report/json.ts). */
interface RunObject {
  readonly url: string | null;
  readonly dryRun: boolean;
  readonly status: string;
  readonly uploaded: number;
  readonly deleted: number;
  readonly unchanged: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly ops?: unknown;
}

/** Runs one action step: the inputs as a deploy, then the outputs. Returns sealup's exit code. */
export async function runAction(env: Env, io: ActionIo): Promise<number> {
  // The runner gives every input declared in action.yml, its default when the step sets none.
  const input = (name: string): string => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  const target = input('target');
  const config = input('config');
  const dryRun = trueOrFalse(input('dry-run'));
  const folder = workingFolder(env.GITHUB_WORKSPACE, input('working-directory') || '.');
  const argv = [
    'deploy',
    ...(target === '' ? [] : [target]),
    ...(dryRun === true ? ['-n'] : []),
    ...(config === '' ? [] : ['-c', config]),
  ];
  const refuse: Problem | undefined =
    dryRun === undefined
      ? { code: 'usage', reason: 'not-true-or-false', name: 'dry-run' }
      : folder.problem;
  let json = '';
  const exitCode = await main(argv, env, {
    ...io,
    stdoutIsTTY: false,
    stdin: noKeyboard,
    stdinIsTTY: false,
    scanHostKey: noScan,
    scanCertificate: () =>
      Promise.reject(new Error('the action runs deploy only: it never scans a certificate')),
    cwd: folder.path,
    json: { write: (text) => (json += text) },
    ...(refuse === undefined ? {} : { refuse }),
  });
  const run = JSON.parse(json) as RunObject;
  // Through report, the one output sink (R1): escaped and redacted like every other line.
  const log = { write: (text: string) => io.stderr.write(text), color: false, terminal: false };
  const warn = (title: string, error: unknown): void => printNotWritten(log, title, error);
  let plan = '';
  if (run.dryRun) {
    try {
      plan = writePlan(env, json);
    } catch (error) {
      warn('Plan file not written', error);
    }
  }
  try {
    writeOutputs(env, {
      status: statusOf(run),
      url: run.url ?? '',
      uploaded: String(run.uploaded),
      deleted: String(run.deleted),
      unchanged: String(run.unchanged),
      bytes: String(run.bytes),
      duration: (run.durationMs / 1000).toFixed(1),
      plan,
    });
  } catch (error) {
    warn('Outputs not written', error);
  }
  return exitCode;
}

/** GitHub's booleans (the toolkit's getBooleanInput): undefined for any other word. */
function trueOrFalse(value: string): boolean | undefined {
  if (['true', 'True', 'TRUE'].includes(value)) return true;
  if (['false', 'False', 'FALSE'].includes(value)) return false;
  return undefined;
}

/**
 * The folder to run in: `given`, relative to the workspace, which must hold it, by its path and,
 * when it exists, by its real path (a link inside the checkout may point out of it).
 */
function workingFolder(
  workspace: string | undefined,
  given: string,
): { readonly path: string; readonly problem?: Problem } {
  if (workspace === undefined || workspace === '') {
    return { path: resolve(given), problem: { code: 'usage', reason: 'no-workspace' } };
  }
  const root = resolve(workspace);
  const path = resolve(root, given);
  const real = (folder: string): string => {
    try {
      return realpathSync.native(folder);
    } catch {
      return folder;
    }
  };
  if (!holds(root, path) || !holds(real(root), real(path))) {
    return { path, problem: { code: 'usage', reason: 'outside-workspace', name: given } };
  }
  return { path };
}

/** Whether `folder` is `root` or inside it (paths' rule, R10). */
function holds(root: string, folder: string): boolean {
  return staysInside(relative(root, folder), process.platform === 'win32' ? 'win32' : 'posix');
}

/** The page's words (0024 §11): `ok` is `deployed`; a dry run that reached its plan, `dry-run`. */
function statusOf(run: RunObject): string {
  if (run.dryRun && run.ops !== undefined) return 'dry-run';
  return run.status === 'ok' ? 'deployed' : run.status;
}

/** Writes a dry run's `--json` object to a new file in RUNNER_TEMP; its path, or '' without one. */
function writePlan(env: Env, json: string): string {
  const folder = env.RUNNER_TEMP;
  if (folder === undefined || folder === '') return '';
  const file = join(folder, `sealup-plan-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(file, json, { flag: 'wx' });
  return file;
}

/** Appends the outputs to GITHUB_OUTPUT, each as `name<<delimiter`, its value, `delimiter`. */
function writeOutputs(env: Env, outputs: Readonly<Record<string, string>>): void {
  const file = env.GITHUB_OUTPUT;
  if (file === undefined || file === '') return;
  const text = Object.entries(outputs)
    .map(([name, value]) => {
      const delimiter = `ghadelimiter_${randomUUID()}`;
      return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
    })
    .join('');
  appendFileSync(file, text);
}
