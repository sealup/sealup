// Runs a CLI program (the built bundle, or a fixture) in a child process under the leak-test
// harness (R1): the canary secrets are in its environment, and its stdout and stderr are checked
// for every form of them before the result is handed back. A test that also has a server checks
// the server's files with `expectNoLeaks` from testkit.
//
// Child processes live here, in test/, because src/ (testkit included) may not start any (R5).

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { canaries, expectNoLeaks } from '../src/testkit/index.ts';

export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  readonly cwd: string;
  /** Added to the environment, after the canaries. */
  readonly env?: Readonly<Record<string, string>>;
}

let cacheHome: string | undefined;
afterAll(() => {
  if (cacheHome !== undefined) rmSync(cacheHome, { recursive: true, force: true });
  cacheHome = undefined;
});

/**
 * The child's environment: this process's, without the GitHub Actions flag (the tests run in
 * GitHub's CI, and a child that saw it would print GitHub's form), then the canaries and the
 * test's own variables. Its cache folder (the hash cache, spec #41 decision 25) is a temp folder
 * of this test file's, removed after it, so no test writes in the user's cache folder.
 */
function childEnv(options: CliOptions): NodeJS.ProcessEnv {
  const { GITHUB_ACTIONS: _, ...outer } = process.env;
  cacheHome ??= mkdtempSync(join(tmpdir(), 'sealup cache '));
  const cache = { LOCALAPPDATA: cacheHome, XDG_CACHE_HOME: cacheHome };
  return { ...outer, NO_COLOR: '1', ...cache, ...canaries, ...options.env };
}

/** Runs `node <args>` with the canaries in the environment, without checking the output. */
export function runWithCanaries(args: readonly string[], options: CliOptions): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: options.cwd,
        env: childEnv(options),
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

/**
 * Starts `node <args>` with the canaries in the environment and hands back the child, so a test
 * can signal it (Ctrl-C), and the run once it ends (its output checked for canaries).
 */
export function startCli(
  args: readonly string[],
  options: CliOptions,
): {
  readonly child: ChildProcess;
  readonly stderrSoFar: () => string;
  readonly done: Promise<CliRun>;
} {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: childEnv(options),
  });
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<CliRun>((resolve, reject) => {
    child.on('close', (code) => {
      try {
        expectNoLeaks({ stdout, stderr, json: parseJson(stdout) });
        // Killed by a signal (no exit code): -1, which no sealup exit code is.
        resolve({ exitCode: code ?? -1, stdout, stderr });
      } catch (leak) {
        reject(leak);
      }
    });
  });
  return { child, stderrSoFar: () => stderr, done };
}

/**
 * Runs `node <args>` like `runWithCanaries`, then fails when a canary shows in stdout, stderr or,
 * when stdout is one JSON object, in that object.
 */
export async function runCli(args: readonly string[], options: CliOptions): Promise<CliRun> {
  const run = await runWithCanaries(args, options);
  expectNoLeaks({ stdout: run.stdout, stderr: run.stderr, json: parseJson(run.stdout) });
  return run;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
