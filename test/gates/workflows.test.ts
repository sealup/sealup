// The workflow rules (decision 0017, R26), proven to bite: each bad workflow in
// test/gates/bad/workflows/ fails scripts/check-workflows.ts, naming its rule; the repo's own
// workflows pass, and so does the workflow `sealup init` writes, but for the sealup step's
// pin to its release tag (spec #24 decision 21); from a release build, which pins it by SHA, it
// passes whole (spec #41 decision 38). The write table (spec #41 decision 37) lets
// each listed job write what it lists, and nothing else. actionlint and zizmor run on the same
// bad files in CI (.github/workflows/ci.yml).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { workflowText } from '../../src/init/index.ts';
import { type GateRun, runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'check-workflows.ts');
const folder = join(repoRoot, 'test', 'gates', 'bad', 'workflows');
const ownRules = ['unpinned', 'permissions', 'pull-request-target'];

/** Runs the gate on `content` saved at `placedAt` (the table keys on the workflow's file name). */
async function runPlaced(placedAt: string, content: string): Promise<GateRun> {
  const root = mkdtempSync(join(tmpdir(), 'sealup workflow '));
  try {
    const file = join(root, ...placedAt.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return await runNode([script, file], repoRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each bad file names the rule it breaks (`# Expect:`); optionally where it goes (`# Placed at:`,
// for a rule that depends on the workflow's file name) and the line that must bite (`# Line:`).
const badFiles = readdirSync(folder)
  .sort()
  .map((name) => {
    const content = readFileSync(join(folder, name), 'utf8');
    const header = (key: string): string | undefined =>
      new RegExp(`^# ${key}: (.+)$`, 'm').exec(content)?.[1]?.trim();
    return {
      name,
      content,
      expect: header('Expect') ?? '',
      placedAt: header('Placed at'),
      line: header('Line') ?? '\\d+',
    };
  });

describe.concurrent('workflows, proven to bite', () => {
  it.each(badFiles.filter((file) => ownRules.includes(file.expect)))(
    '$name fails with $expect',
    async ({ name, content, expect: rule, placedAt, line }) => {
      const run =
        placedAt === undefined
          ? await runNode([script, join(folder, name)], repoRoot)
          : await runPlaced(placedAt, content);
      expect(run.exitCode, run.output).toBe(1);
      expect(run.output).toMatch(new RegExp(`${escapeRegExp(placedAt ?? name)}:${line} ${rule}: `));
    },
  );

  it('leaves the files only actionlint and zizmor catch to them', () => {
    const others = badFiles.filter((file) => !ownRules.includes(file.expect));
    expect(others.map((file) => file.expect)).toEqual(['actionlint, zizmor']);
  });

  it("passes the repo's workflows", async () => {
    const run = await runNode([script], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
  });

  it.each([
    ['release.yml', 'release', ['contents', 'id-token', 'attestations']],
    ['release.yml', 'pages', ['pages', 'id-token']],
    ['pages.yml', 'deploy', ['pages', 'id-token']],
    ['release-please.yml', 'release-please', ['contents', 'pull-requests']],
    ['scorecard.yml', 'analysis', ['id-token']],
  ] as const)(
    'passes %s when job %s writes only what the table allows',
    async (workflow, job, scopes) => {
      const run = await runPlaced(
        `.github/workflows/${workflow}`,
        [
          'name: good',
          'on: push',
          'permissions:',
          '  contents: read',
          'jobs:',
          '  checks:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: echo checked',
          `  ${job}:`,
          '    needs: [checks]',
          '    runs-on: ubuntu-latest',
          '    permissions:',
          ...scopes.map((scope) => `      ${scope}: write`),
          '    steps:',
          '      - run: echo released',
          '',
        ].join('\n'),
      );
      expect(run.exitCode, run.output).toBe(0);
    },
  );

  it('passes public-sync.yml when its App token asks only what the App-token table allows', async () => {
    const run = await runPlaced(
      '.github/workflows/public-sync.yml',
      [
        'name: good',
        'on: push',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  sync:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: App token',
        '        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0',
        '        with:',
        '          permission-contents: write',
        '          permission-workflows: write',
        '',
      ].join('\n'),
    );
    expect(run.exitCode, run.output).toBe(0);
  });

  it.each([
    [
      'npm, a build and .nvmrc',
      {
        build: { manager: 'npm', install: 'npm ci', run: 'npm run build' },
        nodeVersionFile: '.nvmrc',
        fromRepoRoot: '',
      },
    ],
    ['no build, in a subfolder', { fromRepoRoot: 'apps/site' }],
  ] as const)(
    'passes the workflow init writes (%s), but for the sealup pin',
    async (_, options) => {
      const folder = mkdtempSync(join(tmpdir(), 'sealup init workflow '));
      try {
        const file = join(folder, 'deploy.yml');
        writeFileSync(file, workflowText({ version: '1.2.3', ...options }));
        const run = await runNode([script, file], repoRoot);
        expect(run.exitCode, run.output).toBe(1);
        const rules = [...run.output.matchAll(/\.yml:\d+ ([\w-]+): /g)].map((m) => m[1]);
        expect(rules).toEqual(['unpinned']);
        expect(run.output).toContain('"sealup/sealup@v1.2.3" is not pinned to a full commit SHA');
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );

  it('passes the workflow init writes from a release build, the sealup step pinned by SHA', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sealup init workflow '));
    try {
      const file = join(folder, 'deploy.yml');
      const releaseSha = '0123456789abcdef0123456789abcdef01234567';
      writeFileSync(file, workflowText({ version: '1.2.3', releaseSha, fromRepoRoot: '' }));
      const run = await runNode([script, file], repoRoot);
      expect(run.exitCode, run.output).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
