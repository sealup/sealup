// "Needs your look" (spec #1 story 63): lists, in the pull request's job summary, the changed
// files that can weaken the checks (config, CI, hooks, decision records, golden files, the gates
// themselves) and the deleted test files, so a weakened test is flagged, not hidden. A change to a
// frozen seam (decision 0026) is listed first: `contracts`, the Session
// contract suite, and the seams' goldens (test/integration/goldens/seams/, the freeze test).
//
//   node scripts/needs-your-look.ts <base> [head]            diff from git (`base...head`)
//   node scripts/needs-your-look.ts --name-status <file|->   diff from `git diff --name-status`
//   --summary <file>   where to append the summary (default: $GITHUB_STEP_SUMMARY, if set)
//
// The summary also goes to stdout. It reports, it never fails the build: exit 0, or 2 on bad use.
// Golden files: any file under a `goldens/` or `__snapshots__/` folder in test/, or named
// `*.golden` / `*.golden.*`.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import { gitEnv } from './git-env.ts';

const frozenSeam = 'frozen seam';

/** First match wins. The summary lists the first kind, the frozen seams, before the others. */
const protectedKinds: readonly [kind: string, patterns: readonly string[]][] = [
  [
    frozenSeam,
    ['src/contracts/**', 'src/testkit/session-contract*.ts', 'test/integration/goldens/seams/**'],
  ],
  ['CI', ['.github/**']],
  ['hooks', ['.githooks/**', 'scripts/agent-hook.ts', '.claude/settings.json']],
  ['decision record', ['docs/adr/**']],
  [
    'golden file',
    ['test/**/goldens/**', 'test/**/__snapshots__/**', '**/*.golden', '**/*.golden.*'],
  ],
  ['gate', ['scripts/**', 'test/gates/**']],
  [
    'config',
    [
      'package.json',
      'package-lock.json',
      '.npmrc',
      'tsconfig.json',
      'biome.json',
      'knip.json',
      'vitest.config.ts',
      '.gitattributes',
      '.gitignore',
      'AGENTS.md',
    ],
  ],
];

const changeNames: Readonly<Record<string, string>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};

interface Change {
  readonly status: string;
  readonly path: string;
  /** For a rename or copy: the new path. */
  readonly to?: string;
}

const matches = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => posix.matchesGlob(path, pattern));

const kindOf = (path: string): string | undefined =>
  protectedKinds.find(([, patterns]) => matches(path, patterns))?.[0];

const isTest = (path: string): boolean => matches(path, ['test/**', '**/*.test.ts']);

function parseNameStatus(text: string): Change[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [status = '', path = '', to] = line.split('\t');
      return to === undefined
        ? { status: status[0] ?? '', path }
        : { status: status[0] ?? '', path, to };
    });
}

function summarise(changes: readonly Change[]): string {
  const seams: string[] = [];
  const others: string[] = [];
  for (const change of changes) {
    for (const path of [change.path, change.to]) {
      if (path === undefined) continue;
      const kind = kindOf(path);
      if (kind !== undefined) {
        const row = `| \`${path}\` | ${kind} | ${changeNames[change.status] ?? change.status} |`;
        (kind === frozenSeam ? seams : others).push(row);
      }
    }
  }
  const rows = [...seams, ...others];
  const deleted = changes
    .filter(
      (change) =>
        isTest(change.path) &&
        (change.status === 'D' || (change.status === 'R' && !isTest(change.to ?? ''))),
    )
    .map((change) => `- \`${change.path}\``);
  const out = ['## Needs your look', ''];
  if (rows.length === 0 && deleted.length === 0) {
    out.push('Nothing: no protected file changed and no test file deleted.');
  }
  if (rows.length > 0) {
    out.push(
      'Protected files changed (frozen seams, config, CI, hooks, decision records, golden files, ' +
        'gates):',
      '',
      '| File | Kind | Change |',
      '|---|---|---|',
      ...rows,
    );
  }
  if (deleted.length > 0) {
    out.push(...(rows.length > 0 ? [''] : []), 'Test files deleted:', '', ...deleted);
  }
  return `${out.join('\n')}\n`;
}

function gitDiff(base: string, head: string): string {
  return execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', `${base}...${head}`, '--'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
  );
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'name-status': { type: 'string' }, summary: { type: 'string' } },
});
const [base, head = 'HEAD'] = positionals;
const source = values['name-status'];
if (
  (source === undefined && base === undefined) ||
  [base, head].some((ref) => ref?.startsWith('-'))
) {
  console.error('usage: node scripts/needs-your-look.ts <base> [head] | --name-status <file|->');
  process.exit(2);
}
const text =
  source === undefined
    ? gitDiff(base ?? '', head)
    : readFileSync(source === '-' ? 0 : source, 'utf8');
const summary = summarise(parseNameStatus(text));
process.stdout.write(summary);
const target = values.summary ?? process.env.GITHUB_STEP_SUMMARY;
if (target !== undefined && target !== '') appendFileSync(target, summary);
