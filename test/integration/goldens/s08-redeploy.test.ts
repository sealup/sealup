// Golden S08, "Redeploy after a build" (CLI page, docs/exploration/assets/06/scenarios-start-daily.js;
// notes goldens.md). `sealup deploy production`, exit 0. Same lines, words, alignment, symbols and
// colours as the page; names, counts, sizes and times from this fixture. On a terminal the progress
// line is drawn, then replaced by the blank line, so the screen ends as the page shows it.
//
// Page form (14 to upload, 9 to delete, 5,839 unchanged, 2.1 MB, 3.1 s):
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   14 to upload · 9 to delete · 5,839 unchanged                    2.1 MB
//   «progress line»
//
//   ✓ Sealed up and delivered: 14 files to production in 3.1 s.
//     9 old files removed · https://example.com

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createMemoryServer,
  goldenText,
  screenOf,
  steppedClock,
} from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  inGitHub,
  markdown,
  productionConfig,
  runMain,
  summaryFooter,
  summaryTarget,
} from '../../deploy-kit.ts';

// The first build: 30 files that stay, 5 pages that change, 9 hashed bundles that go.
const first: Record<string, string> = {};
for (let i = 0; i < 30; i++) first[`public_html/assets/u${i}.js`] = 'u'.repeat(1024);
for (let i = 0; i < 5; i++) first[`public_html/page${i}.html`] = 'v1';
for (let i = 0; i < 9; i++) first[`public_html/old.${i}.js`] = 'old';

// The second build: the 5 pages changed and 9 new bundles, 150 KiB each: 2,150,400 bytes, which
// the page's units show as 2.1 MB.
const big = 'n'.repeat(150 * 1024);

const s08 = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  14 to upload · 9 to delete · 30 unchanged                       2.1 MB',
  '',
  '  {gb}✓ Sealed up and delivered:{/} 14 files to production in 3.1 s.',
  '    {d}9 old files removed · https://example.com{/}',
];

// The log form (page S08 `ci`, without GitHub's masks and group; spec #24 decision 27): the
// version line first, the timing line after the result. The transfer is under 5 s: no 25/50/75 %.
const timing = '    connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s';
const s08log = (): string[] => ['sealup 0.0.0-source · deploy production', ...s08, timing];

// The GitHub form (page S08 `ci`; spec #24 decisions 27-30): the masks, the version line, then
// the log form with the 23 changes in a group before the result: new files, changed ones, then
// the deletes, each in path order, sizes at column 72.
const size = (path: string): string => `${' '.repeat(72 - 6 - path.length - 6)}150 KB`;
const s08github = [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  ...s08.slice(0, 4),
  '::group::Changes: 14 upload, 9 delete',
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `    {g}+{/} new.${i}.js${size(`new.${i}.js`)}`),
  ...[0, 1, 2, 3, 4].map((i) => `    ~ page${i}.html${size(`page${i}.html`)}`),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `    {r}-{/} old.${i}.js`),
  '::endgroup::',
  ...s08.slice(4),
  timing,
];

// The job summary (page S08 `summary`; spec #24 decision 32): the counts (the 30 unchanged files
// of 1 KiB), the timing, the 23 changes in the group's order.
const nine = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const s08summary = markdown([
  '### ✅ Sealed up and delivered: 14 files to production in 3.1 s',
  '',
  ...summaryTarget,
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Uploaded | 14 | 2.1 MB |',
  '| Deleted | 9 | |',
  '| Unchanged | 30 | 30 KB |',
  '',
  '**3.1 s** · connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s',
  '',
  '<details><summary>Changes (23)</summary>',
  '',
  '```diff',
  ...nine.map((i) => `+ new.${i}.js`),
  ...[0, 1, 2, 3, 4].map((i) => `~ page${i}.html`),
  ...nine.map((i) => `- old.${i}.js`),
  '```',
  '',
  '</details>',
  '',
  summaryFooter(),
]);

// The JSON form (spec "--json object"; the page has none): one object on stdout.
const s08json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: 'production',
  server: 'sftp://deploy@ssh.example.com:22/home/site',
  url: 'https://example.com',
  dryRun: false,
  status: 'ok',
  exitCode: 0,
  uploaded: 14,
  written: 0,
  deleted: 9,
  unchanged: 30,
  bytes: 2_150_400,
  durationMs: 3_100,
  timings: { connect: 0, scan: 0, compare: 0, transfer: 0 },
};

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S08: redeploy after a build', () => {
  let terminal: Run;
  let log: Run;
  let json: Run;
  let github: Run;
  let server = createMemoryServer();
  beforeAll(async () => {
    const run = async (tty: boolean, flags: string[] = [], env = {}): Promise<Run> => {
      const project = createProject(
        productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }),
        first,
      );
      server = createMemoryServer({ loginFolder: '/home/deploy' });
      const options = { cwd: project.root, tty, server };
      await runMain(['deploy', 'production'], options);
      for (let i = 0; i < 5; i++)
        writeFileSync(join(project.root, `public_html/page${i}.html`), big);
      for (let i = 0; i < 9; i++) {
        rmSync(join(project.root, `public_html/old.${i}.js`));
        writeFileSync(join(project.root, `public_html/new.${i}.js`), big);
      }
      return runMain(['deploy', 'production', ...flags], {
        ...options,
        env,
        clock: steppedClock(0, 3_100),
      });
    };
    terminal = await run(true);
    log = await run(false);
    json = await run(false, ['--json']);
    github = await run(false, [], inGitHub);
  });

  it('prints the GitHub form: masks, version line, colour, the changes in a group', () => {
    expect(github.stderr).toBe(goldenText(s08github, { color: true }));
    expect(github.exitCode).toBe(0);
  });

  it('writes the job summary in the GitHub form only (spec #24 decision 32)', () => {
    expect(github.summary).toBe(s08summary);
    expect(log.summary).toBe('');
  });

  it('prints the page lines in colour on a terminal, and exits 0', () => {
    expect(screenOf(terminal.stderr)).toBe(goldenText(s08, { color: true }));
    expect(terminal.stderr).toContain('14 / 14 files');
    expect(terminal.exitCode).toBe(0);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', () => {
    expect(log.stderr).toBe(goldenText(s08log(), { color: false }));
    expect(log.exitCode).toBe(0);
  });

  it('prints one JSON object on stdout with --json, the human lines staying on stderr', () => {
    expect(JSON.parse(json.stdout)).toEqual(s08json);
    expect(json.stderr).toBe(goldenText(s08log(), { color: false }));
    expect(json.exitCode).toBe(0);
  });

  it('ends the plan line at column 72', () => {
    expect(log.stderr.split('\n').find((line) => line.includes('to upload'))).toHaveLength(72);
  });

  it('leaves the new build and nothing of the old one', () => {
    const site = [...server.files().keys()].filter((path) => path.startsWith('/home/site/'));
    expect(site).toHaveLength(44);
    expect(site.some((path) => path.includes('/old.'))).toBe(false);
  });
});
