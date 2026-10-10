// Golden S07, "First deploy" (CLI page, docs/exploration/assets/06/scenarios-start-daily.js; notes
// goldens.md). `sealup deploy production`, exit 0. Same lines, words, alignment, symbols and
// colours as the page; names, counts, sizes and times from this fixture. On a terminal the progress
// line is drawn, then replaced by the next line, so the screen ends as the page shows it; without
// a terminal there is none.
//
// Page form (5,862 files, 41.0 MB, 15.6 s):
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   First deploy: existing files stay. sealup only ever deletes files it uploaded.
//   5,862 to upload                                                41.0 MB
//   «progress line»
//
//   ✓ Sealed up and delivered: 5,862 files to production in 15.6 s.
//     https://example.com

import { beforeAll, describe, expect, it } from 'vitest';
import {
  createMemoryServer,
  expectNoLeaks,
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
import { expectFrozenJson } from '../../freeze-kit.ts';

// The fixture: 1,200 files of 1 KiB each (one in a folder with spaces): 1,228,800 bytes, which
// the page's units show as 1.2 MB. The run lasts 15.6 s on the injected clock (pageClock).
const files: Record<string, string> = { 'public_html/my pages/about us.html': 'x'.repeat(1024) };
for (let i = 1; i < 1200; i++) files[`public_html/assets/f${i}.js`] = 'y'.repeat(1024);

const s07 = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  {b}First deploy:{/} existing files stay. sealup only ever deletes files it uploaded.',
  '  1,200 to upload                                                 1.2 MB',
  '',
  '  {gb}✓ Sealed up and delivered:{/} 1,200 files to production in 15.6 s.',
  '    {d}https://example.com{/}',
];

// The page's S07 times, on the injected clock: one reading each, in deploy's order (the start,
// then scan 1.2 s, connect 0.6 s and compare 0.1 s, each read at its start and its end), then a
// 13.7 s transfer whose 1,200 arrivals come at even steps: 15.6 s in all, as the page.
const arrivals = Array.from(
  { length: 1200 },
  (_, i) => 1900 + Math.round((13_700 * (i + 1)) / 1200),
);
const pageClock = () =>
  steppedClock(0, 0, 1200, 1200, 1800, 1800, 1900, 1900, 1900, ...arrivals, 15_600);

// The log form (page S07 `ci`, without GitHub's masks and group; spec #24 decisions 27, 28): the
// version line first, no bar, one line at 25, 50 and 75 % (the transfer takes over 5 s), the
// timing line after the result. The page's lines with this fixture's counts and sizes, sizes
// padded as the progress line's; 50 % comes at 6.85 s on these even steps, shown 6.8 s (the
// page's 6.9 s is its own transfer's).
const timing = '    connect 0.6 s · scan 1.2 s · compare 0.1 s · transfer 13.7 s';
const marks = [
  '  ↑ 25 %     300 / 1,200 files                     0.3 / 1.2 MB    3.4 s',
  '  ↑ 50 %     600 / 1,200 files                     0.6 / 1.2 MB    6.8 s',
  '  ↑ 75 %     900 / 1,200 files                     0.9 / 1.2 MB   10.3 s',
];
const s07log = [
  'sealup 0.0.0-source · deploy production',
  ...s07.slice(0, 5),
  ...marks,
  ...s07.slice(5),
  timing,
];

// The GitHub form (page S07 `ci`; spec #24 decisions 27-30): the masks of the password first, the
// version line, then the log form with every change in a group, sizes in their column (decision
// 29: the page's `… 5,854 more` is the mockup's shortening), built in code, in plan order.
const uploads = Object.keys(files)
  .map((path) => path.slice('public_html/'.length))
  .sort();
const s07github = [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  ...s07.slice(0, 5),
  ...marks,
  '::group::Changes: 1,200 upload',
  ...uploads.map((path) => `    {g}+{/} ${path}${' '.repeat(72 - 6 - path.length - 4)}1 KB`),
  '::endgroup::',
  ...s07.slice(5),
  timing,
];

// The job summary (page S07 `summary`; spec #24 decision 32): the target table, the counts, the
// first deploy's notice, the timing, then the changes in a `diff` block. The page shows 8 lines
// and `… 5,854 more` (the mockup's shortening); the rule cuts after 1,000 lines, so this
// fixture's 1,200 uploads show 1,000 and `… 200 more (every change is in the log)`.
const s07summary = markdown([
  '### ✅ Sealed up and delivered: 1,200 files to production in 15.6 s',
  '',
  ...summaryTarget,
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Uploaded | 1,200 | 1.2 MB |',
  '',
  'First deploy: existing files stay. sealup only ever deletes files it uploaded.',
  '',
  '**15.6 s** · connect 0.6 s · scan 1.2 s · compare 0.1 s · transfer 13.7 s',
  '',
  '<details><summary>Changes (1,200)</summary>',
  '',
  '```diff',
  ...uploads.slice(0, 1000).map((path) => `+ ${path}`),
  '… 200 more (every change is in the log)',
  '```',
  '',
  '</details>',
  '',
  summaryFooter(),
]);

// The progress line once all 1,200 files are in (page code progressText; 80 columns).
const finalProgress = `  {b}↑{/} {g}${'━'.repeat(30)}{/}   1,200 / 1,200 files   1.2 / 1.2 MB   {d}15.6 s{/}`;

// The JSON form (spec "--json object"; the page has none): one object on stdout.
const s07json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: 'production',
  server: 'sftp://deploy@ssh.example.com:22/home/site',
  url: 'https://example.com',
  dryRun: false,
  status: 'ok',
  exitCode: 0,
  uploaded: 1200,
  written: 0,
  deleted: 0,
  unchanged: 0,
  bytes: 1_228_800,
  durationMs: 15_600,
  timings: { connect: 600, scan: 1200, compare: 100, transfer: 13_700 },
};

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S07: first deploy', () => {
  // One project, deployed twice to fresh servers: from a terminal, then not, with --json (the
  // log run also gives the JSON form: 1,200 uploads a run is the costly part of this file).
  let terminal: Run;
  let log: Run;
  let github: Run;
  let server = createMemoryServer();
  beforeAll(async () => {
    const project = createProject(productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }), files);
    const run = async (tty: boolean, env: Record<string, string>, ...flags: string[]) => {
      server = createMemoryServer({ loginFolder: '/home/deploy' });
      const options = { cwd: project.root, tty, env, clock: pageClock(), server };
      return runMain(['deploy', 'production', ...flags], options);
    };
    terminal = await run(true, {});
    log = await run(false, {}, '--json');
    github = await run(false, inGitHub);
  });

  it('prints the GitHub form: masks, version line, colour, the changes in a group', () => {
    expect(github.stderr).toBe(goldenText(s07github, { color: true }));
    expect(github.exitCode).toBe(0);
  });

  it('writes the job summary, the change list cut after 1,000 lines (spec #24 decision 32)', () => {
    expect(github.summary).toBe(s07summary);
    expect(log.summary).toBe('');
    expect(terminal.summary).toBe('');
  });

  it('prints the page lines in colour on a terminal, and exits 0', () => {
    expect(screenOf(terminal.stderr)).toBe(goldenText(s07, { color: true }));
    expect(terminal.stdout).toBe('');
    expect(terminal.exitCode).toBe(0);
  });

  it('draws the progress line on a terminal, up to every file arrived', () => {
    const done = goldenText([finalProgress], { color: true }).slice(0, -1);
    expect(terminal.stderr).toContain(`\r\x1b[2K${done}\r\x1b[2K`);
  });

  it('prints the log form without colour when not a terminal (spec #24 decisions 27, 28)', () => {
    expect(log.stderr).toBe(goldenText(s07log, { color: false }));
    expect(log.stderr).not.toContain('━');
    expect(log.exitCode).toBe(0);
  });

  it('prints one JSON object on stdout with --json, the human lines staying on stderr', () => {
    expect(log.stdout.endsWith('}\n')).toBe(true);
    expect(log.stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(log.stdout)).toEqual(s07json);
    expectFrozenJson('a success', log.stdout, 'json-success.golden');
  });

  it('keeps every line within 80 columns, sizes ending at column 72', () => {
    const lines = log.stderr.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines.find((line) => line.includes('to upload'))).toHaveLength(72);
  });

  it('leaves the files and the manifest on the server, with no secret in them (R1)', () => {
    const tree = [...server.files().keys()];
    expect(tree.filter((path) => path.startsWith('/home/site/'))).toHaveLength(1200);
    expect(tree.filter((path) => path.startsWith('/home/deploy/.sealup/'))).toHaveLength(1);
    expect(tree.some((path) => path.endsWith('.tmp'))).toBe(false);
    const bytes = Object.fromEntries([...server.files()].map(([path, file]) => [path, file.bytes]));
    expectNoLeaks(bytes);
  });
});
