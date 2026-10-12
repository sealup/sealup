// What main() reads of the process it runs in besides the config's variables: whether the
// terminal shows Unicode symbols and who runs a deploy (the lock's note), from the environment it
// is given, never process.env, so a test sets them; and what parseArgs' error says of the command
// line. Moved out of index.ts (its 800-line cap) in plan 06 T05.

import type { Env } from '../config/index.ts';
import type { Problem } from '../contracts/index.ts';
import type { Runner } from '../deploy/index.ts';

/** parseArgs' error as facts (report words them): the flag it names, never a value. */
export function usageProblem(error: unknown): Problem {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : '';
  const named = (flag: string | undefined) => (flag === undefined ? {} : { name: flag });
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return { code: 'usage', reason: 'unknown-flag', ...named(/'([^']+)'/.exec(message)?.[1]) };
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const flag = /'(-\w, --[\w-]+|--[\w-]+)/.exec(message)?.[1];
    return { code: 'usage', reason: 'missing-value', ...named(flag) };
  }
  throw error;
}

/**
 * Whether a terminal shows ✓ ✗ ━ ─ (decision 0024 §3; the is-unicode-supported rules, from the
 * injected environment): everywhere but the Linux console, and on Windows only in terminals
 * known to (Windows Terminal, VS Code, JetBrains, ConEmu/Cmder, Terminus, Alacritty, xterm) or
 * in CI. The legacy Windows console's font lacks them. Without a terminal the bytes go to a file
 * or a pipe as UTF-8, so the symbols stay.
 */
export function unicodeTerminal(platform: string, env: Env): boolean {
  if (platform !== 'win32') return env.TERM !== 'linux';
  return (
    Boolean(env.CI) ||
    Boolean(env.WT_SESSION) ||
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'Terminus-Sublime' ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
  );
}

/**
 * Who runs this deploy, for the lock's note (decision 0031): the machine's name, and in GitHub
 * Actions the run's page, from the variables the runner sets.
 */
export function runnerOf(env: Env, machine: string): Runner {
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  const inActions = GITHUB_ACTIONS === 'true' && GITHUB_SERVER_URL !== undefined;
  return inActions && GITHUB_REPOSITORY !== undefined && GITHUB_RUN_ID !== undefined
    ? { machine, ciRun: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` }
    : { machine };
}
