// The code gates, defined once. `check.ts` runs them on the repo, and the proven-to-bite tests
// (test/gates/) run the very same commands on a temp project that holds one bad file per rule.
// Each gate is a JavaScript file run with the current `node`: no shell, no `.cmd` shims, so the commands behave the same on Windows and Linux.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { gitEnv } from './git-env.ts';

export type GateName = 'typecheck' | 'lint' | 'imports' | 'knip' | 'test';

export const gateNames: readonly GateName[] = ['typecheck', 'lint', 'imports', 'knip', 'test'];

/** The repo root (this file lives in `scripts/`). */
export const repoRoot: string = join(import.meta.dirname, '..');

const bin = (...parts: string[]): string => join(repoRoot, 'node_modules', ...parts);

export const tools = {
  tsc: bin('typescript', 'bin', 'tsc'),
  biome: bin('@biomejs', 'biome', 'bin', 'biome'),
  knip: bin('knip', 'bin', 'knip.js'),
  vitest: bin('vitest', 'vitest.mjs'),
  importRules: join(repoRoot, 'scripts', 'import-rules.ts'),
} as const;

/** Arguments for `node` that run one gate in the current folder. */
export function gateArgs(name: GateName): string[] {
  switch (name) {
    case 'typecheck':
      return [tools.tsc, '--noEmit', '--pretty', 'false', '-p', '.'];
    case 'lint':
      return [tools.biome, 'check', '--error-on-warnings', '--max-diagnostics=none'];
    case 'imports':
      return [tools.importRules];
    case 'knip':
      return [tools.knip, '--no-progress'];
    case 'test':
      return [tools.vitest, 'run', '--project', 'unit', '--project', 'integration'];
  }
}

export function isGateName(value: string): value is GateName {
  return (gateNames as readonly string[]).includes(value);
}

export interface StepResult {
  readonly label: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly output: string;
}

/**
 * Runs `node <args>` in `cwd` (the repo root by default), without the git variables a hook hands
 * down (scripts/git-env.ts), and collects its output; never throws.
 */
export function runStep(
  label: string,
  args: readonly string[],
  cwd: string = repoRoot,
): Promise<StepResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: gitEnv({ FORCE_COLOR: '0' }) },
      (error, stdout, stderr) => {
        resolve({
          label,
          ok: error === null,
          ms: performance.now() - started,
          output: `${stdout}${stderr}`.trim(),
        });
      },
    );
  });
}

/** Prints the full output of each failed step, then one status line per step. */
export function printResults(results: readonly StepResult[], started: number): void {
  for (const result of results.filter((r) => !r.ok)) {
    console.error(`\n── ${result.label} failed ──\n${result.output}\n`);
  }
  for (const result of results) {
    const seconds = (result.ms / 1000).toFixed(1);
    console.error(`${result.ok ? 'ok    ' : 'FAILED'} ${result.label.padEnd(9)} ${seconds} s`);
  }
  const total = ((performance.now() - started) / 1000).toFixed(1);
  const failed = results.filter((r) => !r.ok).length;
  console.error(
    failed === 0
      ? `all passed in ${total} s`
      : `${failed} of ${results.length} failed in ${total} s`,
  );
}
