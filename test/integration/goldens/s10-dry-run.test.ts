// Golden S10, "Dry run" (CLI page, docs/exploration/assets/06/scenarios-start-daily.js; notes
// goldens.md). `sealup deploy --dry-run production`, exit 0. Same lines, words, alignment, symbols and
// colours as the page; names, counts and sizes from this fixture. No progress line, no ✓.
//
// Page form (14 uploads, 9 deletes, 1 kept, 5,839 unchanged; abridged):
//    DRY RUN  nothing will change on production
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   Would upload 14 files                                           2.1 MB
//     + www/main.4f2a9c1e.js                                        412 KB
//     ~ www/index.html                                                4 KB
//   Would delete 9 files  (sealup uploaded them; they are no longer in your build)
//     - www/main.8b1e3d07.js
//   Would keep 1 file
//     · www/robots.txt  excluded now, never deleted
//   5,839 unchanged
//
//    DRY RUN  nothing was changed. To apply: sealup deploy production

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMemoryServer, goldenText, steppedClock } from '../../../src/testkit/index.ts';
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

const kib = (n: number): string => 'k'.repeat(n * 1024);

const config = productionConfig({
  upload: '\n  public_html: www\n  api: api',
  password: 'SEALUP_CANARY_PASSWORD',
});
const excluding = config.replace('targets:', 'exclude: [public_html/robots.txt]\ntargets:');

// The first build: 1,001 files that stay, 2 that change, 2 bundles that go, robots.txt (excluded
// before the second run, so it stays on the server).
const first: Record<string, string> = {
  'public_html/index.html': 'v1',
  'public_html/main.8b1e3d07.js': 'v1',
  'public_html/admin/main.93c5b8e0.js': 'v1',
  'public_html/admin/index.html': 'admin',
  'public_html/robots.txt': 'User-agent: *',
  'api/routes/api.php': 'v1',
};
for (let i = 0; i < 1000; i++) first[`public_html/assets/f${i}.js`] = `asset ${i}`;

const s10 = [
  ' {inv} DRY RUN {/} nothing will change on production',
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  {b}Would upload 4 files{/}                                            424 KB',
  '    {g}+{/} www/admin/main.1b7e9f30.js                                    3 KB',
  '    {g}+{/} www/main.4f2a9c1e.js                                        412 KB',
  '    ~ api/routes/api.php                                            5 KB',
  '    ~ www/index.html                                                4 KB',
  '  {b}Would delete 2 files{/}  {d}(sealup uploaded them; they are no longer in your build){/}',
  '    {r}-{/} www/admin/main.93c5b8e0.js',
  '    {r}-{/} www/main.8b1e3d07.js',
  '  {b}Would keep 1 file{/}',
  '    · www/robots.txt  {d}excluded now, never deleted{/}',
  '  1,001 unchanged',
  '',
  ' {inv} DRY RUN {/} nothing was changed. To apply: {b}sealup deploy production{/}',
];

// The log form (page S10 `ci`, without GitHub's masks; spec #24 decision 27): the version line
// first, then the same lines; a dry run has no result, so no timing line. The page's version line
// repeats the dry-run flag: here it holds the command and the target only, never a flag (decision 27).
const s10log = (): string[] => ['sealup 0.0.0-source · deploy production', ...s10];

// The JSON form (spec "--json object"; the page has none): one object on stdout, with every
// operation the run would do, in the order of the list above. A delete or a kept file has no size.
const s10json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: 'production',
  server: 'sftp://deploy@ssh.example.com:22/home/site',
  url: 'https://example.com',
  dryRun: true,
  status: 'ok',
  exitCode: 0,
  uploaded: 4,
  written: 0,
  deleted: 2,
  unchanged: 1001,
  bytes: 434_176,
  durationMs: 2_000,
  timings: { connect: 0, scan: 0, compare: 0, transfer: 0 },
  ops: [
    { op: 'upload', path: 'www/admin/main.1b7e9f30.js', reason: 'new', size: 3072 },
    { op: 'upload', path: 'www/main.4f2a9c1e.js', reason: 'new', size: 421_888 },
    { op: 'upload', path: 'api/routes/api.php', reason: 'changed', size: 5120 },
    { op: 'upload', path: 'www/index.html', reason: 'changed', size: 4096 },
    { op: 'delete', path: 'www/admin/main.93c5b8e0.js', reason: 'left-build', size: null },
    { op: 'delete', path: 'www/main.8b1e3d07.js', reason: 'left-build', size: null },
    { op: 'keep', path: 'www/robots.txt', reason: 'excluded', size: null },
  ],
};

// The job summary (page S10 `summary`; spec #24 decision 32): 📋, the "would" counts (the 1,001
// unchanged files hold 8,895 bytes), the command that applies it, the timing without a transfer,
// then every change and the kept file; the count leaves the kept file out, as the page's does.
const s10summary = markdown([
  '### 📋 Dry run: nothing was changed on production',
  '',
  ...summaryTarget,
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Would upload | 4 | 424 KB |',
  '| Would delete | 2 | |',
  '| Would keep | 1 | |',
  '| Unchanged | 1,001 | 9 KB |',
  '',
  'To apply: run `sealup deploy production`, or this workflow without `dry-run`.',
  '',
  '**2.0 s** · connect 0.0 s · scan 0.0 s · compare 0.0 s',
  '',
  '<details><summary>Changes (6)</summary>',
  '',
  '```diff',
  '+ www/admin/main.1b7e9f30.js',
  '+ www/main.4f2a9c1e.js',
  '~ api/routes/api.php',
  '~ www/index.html',
  '- www/admin/main.93c5b8e0.js',
  '- www/main.8b1e3d07.js',
  '  www/robots.txt  kept: excluded now, never deleted',
  '```',
  '',
  '</details>',
  '',
  summaryFooter(),
]);

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S10: dry run', () => {
  let terminal: Run;
  let log: Run;
  let json: Run;
  let github: Run;
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  let before: ReturnType<typeof server.files>;
  let foldersBefore: readonly string[];
  beforeAll(async () => {
    const project = createProject(config, first);
    const options = { cwd: project.root, server };
    await runMain(['deploy', 'production'], options);
    const at = (path: string): string => join(project.root, ...path.split('/'));
    writeFileSync(project.config, excluding);
    writeFileSync(at('public_html/index.html'), kib(4));
    writeFileSync(at('api/routes/api.php'), kib(5));
    writeFileSync(at('public_html/main.4f2a9c1e.js'), kib(412));
    writeFileSync(at('public_html/admin/main.1b7e9f30.js'), kib(3));
    rmSync(at('public_html/main.8b1e3d07.js'));
    rmSync(at('public_html/admin/main.93c5b8e0.js'));
    before = server.files();
    foldersBefore = server.folders();
    const argv = ['deploy', '--dry-run', 'production'];
    terminal = await runMain(argv, { ...options, tty: true, clock: steppedClock(0, 2_000) });
    log = await runMain(argv, { ...options, clock: steppedClock(0, 2_000) });
    json = await runMain([...argv, '--json'], { ...options, clock: steppedClock(0, 2_000) });
    github = await runMain(argv, { ...options, env: inGitHub, clock: steppedClock(0, 2_000) });
  });

  // The GitHub form (page S10 `ci`): the masks, then the log form. A dry run lists every change
  // itself, so no group.
  it('prints the GitHub form: masks, version line, colour, every change listed', () => {
    expect(github.stderr).toBe(goldenText([...canaryMasks, ...s10log()], { color: true }));
    expect(github.exitCode).toBe(0);
  });

  it('writes the job summary in the GitHub form only (spec #24 decision 32)', () => {
    expect(github.summary).toBe(s10summary);
    expect(log.summary).toBe('');
  });

  it('prints the page lines in colour on a terminal, and exits 0', () => {
    expect(terminal.stderr).toBe(goldenText(s10, { color: true }));
    expect(terminal.exitCode).toBe(0);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', () => {
    expect(log.stderr).toBe(goldenText(s10log(), { color: false }));
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toBe('');
  });

  it('ends sizes at column 72 and keeps every line inside 80 columns', () => {
    const lines = log.stderr.split('\n');
    expect(lines.find((line) => line.includes('Would upload'))).toHaveLength(72);
    expect(lines.find((line) => line.includes('www/main.4f2a9c1e.js'))).toHaveLength(72);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('prints one JSON object on stdout with --json, the human lines staying on stderr', () => {
    expect(JSON.parse(json.stdout)).toEqual(s10json);
    expectFrozenJson('a dry run', json.stdout, 'json-dry-run.golden');
    expect(json.stderr).toBe(goldenText(s10log(), { color: false }));
    expect(json.exitCode).toBe(0);
  });

  it('changes nothing on the server, the manifest included', () => {
    expect(server.files()).toEqual(before);
    expect(server.folders()).toEqual(foldersBefore);
  });
});
