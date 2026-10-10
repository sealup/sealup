// Golden S20, "Partial failure: quota full" (CLI page, docs/exploration/assets/06/
// scenarios-problems.js; notes goldens.md). `sealup deploy production`, exit 1. The memory
// server refuses uploads 12, 13 and 14 of 14 with quota full; the 11 others arrive (they were in
// flight). Same lines, words, alignment, symbols and colours as the page; names, counts and sizes
// from this fixture. On a terminal the frozen progress line is replaced by the `✗` line (no
// blank line between them on the page).
//
// Page form (14 to upload, 9 to delete, 5,839 unchanged, 2.1 MB):
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   14 to upload · 9 to delete · 5,839 unchanged                    2.1 MB
//   «progress line»
//   ✗ Upload stopped: production is out of space.
//     ssh.example.com refused 3 files: no space left (quota full).
//       www/main.4f2a9c1e.js                                        412 KB
//       www/polyfills.b7e2c4d9.js                                    34 KB
//       www/styles.2d8f1a6c.css                                      88 KB
//     Free space in your hosting panel (old backups, logs, mailboxes).
//
//     production now has 11 of 14 new files. Run the same command again to finish.
//     sealup recorded what arrived, so the rerun sends only the 3 missing files.
//     The 9 old files were kept: sealup deletes only after every upload is in.
//     Until then the site may serve a mix of old and new files.
//     More: sealup.dev/e/quota-full

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMemoryServer, goldenText, screenOf } from '../../../src/testkit/index.ts';
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

// The first build: 30 files that stay, 9 bundles that go.
const first: Record<string, string> = {};
for (let i = 0; i < 30; i++) first[`public_html/stay/s${i}.txt`] = 'stay';
for (let i = 0; i < 9; i++) first[`public_html/old.${i}.js`] = 'old';

// The second build adds 14 files: 11 chunks of 150 KiB that arrive, then the page's three
// (412, 34 and 88 KiB) that the full disk refuses: 2,236,416 bytes, shown as 2.1 MB.
const chunk = 'c'.repeat(150 * 1024);
const refused: Record<string, number> = {
  'main.4f2a9c1e.js': 412,
  'polyfills.b7e2c4d9.js': 34,
  'styles.2d8f1a6c.css': 88,
};

const s20 = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  14 to upload · 9 to delete · 30 unchanged                       2.1 MB',
  '  {rb}✗{/} {b}Upload stopped: production is out of space.{/}',
  '    ssh.example.com refused 3 files: no space left (quota full).',
  '      www/main.4f2a9c1e.js                                        412 KB',
  '      www/polyfills.b7e2c4d9.js                                    34 KB',
  '      www/styles.2d8f1a6c.css                                      88 KB',
  '    Free space in your hosting panel (old backups, logs, mailboxes).',
  '',
  '    production now has 11 of 14 new files. Run the same command again to finish.',
  '    sealup recorded what arrived, so the rerun sends only the 3 missing files.',
  '    The 9 old files were kept: sealup deletes only after every upload is in.',
  '    Until then the site may serve a mix of old and new files.',
  '    {d}More: sealup.dev/e/quota-full{/}',
];

// The GitHub form (page S20 `ci`): the masks, the version line, the plan line, every change in
// the group with its size (spec #24 decision 29; the page's group drops the sizes and the `+`
// colour, unlike S07 and S08: read as the mockup's slip), the error, then the annotation.
const sized = (path: string, size: string): string =>
  `${path}${' '.repeat(72 - 6 - path.length - size.length)}${size}`;
const arrived = Array.from({ length: 11 }, (_, i) => `www/assets/chunk.${i}.js`);
const news = [...arrived, ...Object.keys(refused).map((name) => `www/${name}`)].sort();
const sizeOf = (path: string): string => `${refused[path.slice(4)] ?? 150} KB`;
const s20github = [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  ...s20.slice(0, 4),
  '::group::Changes: 14 upload, 9 delete',
  ...news.map((path) => `    {g}+{/} ${sized(path, sizeOf(path))}`),
  ...Array.from({ length: 9 }, (_, i) => `    {r}-{/} www/old.${i}.js`),
  '::endgroup::',
  ...s20.slice(4),
  '::error title=Server out of space::ssh.example.com refused 3 of 14 files: no space left (quota full). production now has 11 of 14 new files; the 9 old files were kept. Free space in your hosting panel, then re-run this job to finish.',
];

// The job summary (page S20 `summary`; spec #24 decision 32): ⚠️ since the server changed, the
// cause and the fix, the target table, what arrived of what (11 × 150 KiB), what did not (the
// page's 534 KB), the deletes held back, the 30 unchanged files (4 bytes each), then the files
// that did not arrive with their sizes in a column.
const s20summary = markdown([
  '### ⚠️ Stopped part-way: 11 of 14 files reached production',
  '',
  '> [!CAUTION]',
  '> `ssh.example.com` refused 3 files: **no space left (quota full)**. The 9 old files were kept: sealup deletes only after every upload is in. Until the next run, the site may serve a mix of old and new files.',
  '>',
  '> **Fix:** free space in your hosting panel (old backups, logs, mailboxes), then re-run this job. sealup recorded what arrived, so it sends only the 3 missing files.',
  '',
  ...summaryTarget,
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Uploaded | 11 of 14 | 1.6 MB |',
  '| Not uploaded | 3 | 534 KB |',
  '| Deleted | 0 of 9 (kept until every upload is in) | |',
  '| Unchanged | 30 | 120 B |',
  '',
  '<details><summary>Not uploaded (3)</summary>',
  '',
  '```',
  'www/main.4f2a9c1e.js         412 KB',
  'www/polyfills.b7e2c4d9.js     34 KB',
  'www/styles.2d8f1a6c.css       88 KB',
  '```',
  '',
  '</details>',
  '',
  summaryFooter('quota-full'),
]);

// The JSON form (spec "--json object"; the page has none): what arrived, each file that failed
// with its code, and the error in the terminal's words.
const s20json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: 'production',
  server: 'sftp://deploy@ssh.example.com:22/home/site',
  url: 'https://example.com',
  dryRun: false,
  status: 'partial',
  exitCode: 1,
  uploaded: 11,
  written: 0,
  deleted: 0,
  unchanged: 30,
  bytes: 11 * 150 * 1024,
  durationMs: 0,
  timings: { connect: 0, scan: 0, compare: 0, transfer: 0 },
  failed: [
    { path: 'www/main.4f2a9c1e.js', code: 'quota' },
    { path: 'www/polyfills.b7e2c4d9.js', code: 'quota' },
    { path: 'www/styles.2d8f1a6c.css', code: 'quota' },
  ],
  error: {
    code: 'quota-full',
    message: 'Upload stopped: production is out of space.',
    fix: [
      'ssh.example.com refused 3 files: no space left (quota full).',
      'www/main.4f2a9c1e.js                                        412 KB',
      'www/polyfills.b7e2c4d9.js                                    34 KB',
      'www/styles.2d8f1a6c.css                                      88 KB',
      'Free space in your hosting panel (old backups, logs, mailboxes).',
    ].join('\n'),
    state: [
      'production now has 11 of 14 new files. Run the same command again to finish.',
      'sealup recorded what arrived, so the rerun sends only the 3 missing files.',
      'The 9 old files were kept: sealup deletes only after every upload is in.',
      'Until then the site may serve a mix of old and new files.',
    ].join('\n'),
  },
};

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S20: partial failure, quota full', () => {
  let terminal: Run;
  let log: Run;
  let rerun: Run;
  let json: Run;
  let github: Run;
  let server = createMemoryServer();
  beforeAll(async () => {
    const run = async (tty: boolean, flags: string[] = [], env = {}): Promise<Run> => {
      const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }).replace(
        'upload: public_html',
        'upload: { public_html: www }',
      );
      const project = createProject(config, first);
      server = createMemoryServer({ loginFolder: '/home/deploy' });
      const options = { cwd: project.root, tty, server };
      await runMain(['deploy', 'production'], options);
      for (let i = 0; i < 9; i++) rmSync(join(project.root, `public_html/old.${i}.js`));
      mkdirSync(join(project.root, 'public_html/assets'));
      for (let i = 0; i < 11; i++) {
        writeFileSync(join(project.root, `public_html/assets/chunk.${i}.js`), chunk);
      }
      for (const [name, kib] of Object.entries(refused)) {
        writeFileSync(join(project.root, 'public_html', name), 'x'.repeat(kib * 1024));
      }
      // Uploads go out in path order: the 12th, 13th and 14th are the page's three. The lock's
      // note (decision 0031) is the first put, so they are puts 13 to 15.
      for (const nth of [13, 14, 15]) server.faults.failWrite(nth, 'quota');
      const failed = await runMain(['deploy', 'production', ...flags], { ...options, env });
      // The last run (GitHub's) is run again on its server, now with room (the rerun test).
      if (env === inGitHub) {
        rerun = await runMain(['deploy', 'production'], options);
      }
      return failed;
    };
    terminal = await run(true);
    json = await run(false, ['--json']);
    log = await run(false);
    github = await run(false, [], inGitHub);
  });

  it('prints the GitHub form: masks, every change in a group, the error, one annotation', () => {
    expect(github.stderr).toBe(goldenText(s20github, { color: true }));
    expect(github.exitCode).toBe(1);
  });

  it('writes the job summary: what arrived, what did not, the fix (spec #24 decision 32)', () => {
    expect(github.summary).toBe(s20summary);
    expect(log.summary).toBe('');
  });

  it('prints the page lines in colour on a terminal, and exits 1', () => {
    expect(screenOf(terminal.stderr)).toBe(goldenText(s20, { color: true }));
    expect(terminal.exitCode).toBe(1);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', () => {
    expect(log.stderr).toBe(
      goldenText(['sealup 0.0.0-source · deploy production', ...s20], { color: false }),
    );
    expect(log.exitCode).toBe(1);
  });

  it('prints one JSON object on stdout with --json, the human lines staying on stderr', () => {
    expect(JSON.parse(json.stdout)).toEqual(s20json);
    expectFrozenJson('a part-way stop', json.stdout, 'json-part-way.golden');
    const jsonLog = ['sealup 0.0.0-source · deploy production', ...s20];
    expect(json.stderr).toBe(goldenText(jsonLog, { color: false }));
    expect(json.exitCode).toBe(1);
  });

  it('ends the not-arrived list at column 72', () => {
    const line = log.stderr.split('\n').find((text) => text.includes('main.4f2a9c1e.js'));
    expect(line).toHaveLength(72);
  });

  it('finishes on the rerun: the 3 missing files, then the 9 deletes', () => {
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stderr).toContain('3 to upload · 9 to delete');
    const site = [...server.files().keys()].filter((path) => path.startsWith('/home/site/'));
    expect(site.some((path) => path.includes('/old.'))).toBe(false);
    expect(site).toContain('/home/site/www/styles.2d8f1a6c.css');
  });
});
