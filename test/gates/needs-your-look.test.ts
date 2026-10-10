// "Needs your look" (spec #1 story 63), proven to bite: a diff that touches each kind of
// protected file and deletes tests lists every one of them, the frozen seams first (spec #15,
// decision 10); an ordinary diff lists nothing.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'needs-your-look.ts');

/** `git diff --name-status` lines: status, tab, path (a rename has two paths). */
const diff = (...lines: string[]): string => `${lines.join('\n')}\n`;

const frozenSeams = [
  {
    line: 'M\tsrc/contracts/index.ts',
    file: 'src/contracts/index.ts',
    kind: 'frozen seam',
    change: 'modified',
  },
  {
    line: 'M\tsrc/testkit/session-contract.ts',
    file: 'src/testkit/session-contract.ts',
    kind: 'frozen seam',
    change: 'modified',
  },
  {
    line: 'A\tsrc/testkit/session-contract-list-get.ts',
    file: 'src/testkit/session-contract-list-get.ts',
    kind: 'frozen seam',
    change: 'added',
  },
  {
    line: 'M\ttest/integration/goldens/seams/shape.golden',
    file: 'test/integration/goldens/seams/shape.golden',
    kind: 'frozen seam',
    change: 'modified',
  },
];

const protectedChanges = [
  {
    line: 'M\t.github/workflows/ci.yml',
    file: '.github/workflows/ci.yml',
    kind: 'CI',
    change: 'modified',
  },
  { line: 'A\t.githooks/pre-push', file: '.githooks/pre-push', kind: 'hooks', change: 'added' },
  {
    line: 'M\tscripts/agent-hook.ts',
    file: 'scripts/agent-hook.ts',
    kind: 'hooks',
    change: 'modified',
  },
  {
    line: 'M\tdocs/adr/0011-distribution-zero-dependency-bundle.md',
    file: 'docs/adr/0011-distribution-zero-dependency-bundle.md',
    kind: 'decision record',
    change: 'modified',
  },
  {
    line: 'M\ttest/unit/report/goldens/s07-first-deploy.txt',
    file: 'test/unit/report/goldens/s07-first-deploy.txt',
    kind: 'golden file',
    change: 'modified',
  },
  {
    line: 'M\ttest/unit/cli/__snapshots__/help.test.ts.snap',
    file: 'test/unit/cli/__snapshots__/help.test.ts.snap',
    kind: 'golden file',
    change: 'modified',
  },
  {
    line: 'M\tscripts/import-rules.ts',
    file: 'scripts/import-rules.ts',
    kind: 'gate',
    change: 'modified',
  },
  {
    line: 'M\ttest/gates/bad/biome/no-console.ts',
    file: 'test/gates/bad/biome/no-console.ts',
    kind: 'gate',
    change: 'modified',
  },
  { line: 'M\tbiome.json', file: 'biome.json', kind: 'config', change: 'modified' },
  { line: 'M\tpackage.json', file: 'package.json', kind: 'config', change: 'modified' },
  { line: 'M\t.npmrc', file: '.npmrc', kind: 'config', change: 'modified' },
  { line: 'M\tAGENTS.md', file: 'AGENTS.md', kind: 'config', change: 'modified' },
  { line: 'D\ttsconfig.json', file: 'tsconfig.json', kind: 'config', change: 'deleted' },
];

const deletedTests = [
  { line: 'D\ttest/unit/plan/plan.test.ts', file: 'test/unit/plan/plan.test.ts' },
  // Moved out of the test folders, so it no longer runs.
  {
    line: 'R100\ttest/integration/sftp.test.ts\tdocs/old-sftp.test.txt',
    file: 'test/integration/sftp.test.ts',
  },
];

const ordinary = [
  'M\tsrc/plan/index.ts',
  'A\ttest/unit/plan/rmdir.test.ts',
  'R090\ttest/unit/a.test.ts\ttest/unit/b.test.ts',
  'M\tdocs/product/ideas.md',
];

describe('needs your look, proven to bite', () => {
  let output = '';
  let exitCode = -1;
  let summaryFile = '';
  let summary = '';
  let folder = '';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'sealup-look-'));
    summaryFile = join(folder, 'summary.md');
    // The frozen seams come last in the diff: the summary lists them first all the same.
    const input = diff(
      ...[...protectedChanges, ...deletedTests, ...frozenSeams].map((c) => c.line),
      ...ordinary,
    );
    const run = await runNode(
      [script, '--name-status', '-', '--summary', summaryFile],
      folder,
      input,
    );
    output = run.output;
    exitCode = run.exitCode;
    summary = readFileSync(summaryFile, 'utf8');
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('reports without failing the build', () => {
    expect(exitCode, output).toBe(0);
  });

  it.each([...frozenSeams, ...protectedChanges])(
    'lists $file as $kind, $change',
    ({ file, kind, change }) => {
      expect(summary).toContain(`| \`${file}\` | ${kind} | ${change} |`);
    },
  );

  it('lists the frozen seams before the other protected files', () => {
    const rows = summary.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows.slice(0, frozenSeams.length).every((row) => row.includes('| frozen seam |'))).toBe(
      true,
    );
    expect(rows.slice(frozenSeams.length).some((row) => row.includes('frozen seam'))).toBe(false);
    expect(summary).toContain('Protected files changed (frozen seams, config,');
  });

  it.each(deletedTests)('lists the deleted test $file', ({ file }) => {
    expect(summary).toContain(`- \`${file}\``);
  });

  it('lists no ordinary change', () => {
    expect(summary).not.toContain('src/plan/index.ts');
    expect(summary).not.toContain('rmdir.test.ts');
    expect(summary).not.toContain('a.test.ts');
    expect(summary).not.toContain('ideas.md');
  });

  it('writes the same text to stdout', () => {
    expect(output).toContain('## Needs your look');
    expect(output).toContain('.github/workflows/ci.yml');
  });
});

describe('needs your look, on an ordinary diff', () => {
  it('says nothing needs a look', async () => {
    const run = await runNode([script, '--name-status', '-'], repoRoot, diff(...ordinary));
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('Nothing: no protected file changed and no test file deleted.');
  });

  it('reads the diff from git between two refs', async () => {
    const run = await runNode([script, 'HEAD', 'HEAD'], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('## Needs your look');
  });

  it('refuses a ref that git would read as an option', async () => {
    const run = await runNode([script, '--', '--output=x'], repoRoot);
    expect(run.exitCode).toBe(2);
  });
});
