// The home page's samples (sealup.dev/, ticket #67, decision 0037): the `sealup.yml` the page
// shows, and what sealup prints for it, on a terminal and in the job summary. The page keeps
// these lines in site/src/home/samples.ts; the site's tests check each one is a line of this file.
// One file for all of them, so the config and the runs shown always agree.
//
// The config is `sealup init`'s shorthand form (S02) plus a `url`: one target, named after the
// server's host (ruling 4). The redeploy is S08's change set under `dist/`; the dry run is a
// small one, as S10's.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canaries,
  createMemoryServer,
  goldenText,
  screenOf,
  steppedClock,
} from '../../src/testkit/index.ts';
import {
  createProject,
  hostKeyFingerprint,
  hostKeyLine,
  inGitHub,
  markdown,
  ref,
  runMain,
} from '../deploy-kit.ts';

// The page's sealup.yml (its host key shortened on the page, which says so).
const config = [
  'server: sftp://deploy@ssh.example.com/home/site',
  `password: ${ref('SEALUP_PASSWORD')}`,
  `hostKey: ${hostKeyLine}`,
  'upload: dist',
  'url: https://example.com',
  '',
].join('\n');

const env = { SEALUP_PASSWORD: canaries.SEALUP_CANARY_PASSWORD };

// The redeploy (the page's terminal): 30 files that stay, 5 pages that change, 9 hashed bundles
// replaced by 9 new ones of 150 KiB each (2,150,400 bytes, shown as 2.1 MB).
const first: Record<string, string> = {};
for (let i = 0; i < 30; i++) first[`dist/assets/u${i}.js`] = 'u'.repeat(1024);
for (let i = 0; i < 5; i++) first[`dist/page${i}.html`] = 'v1';
for (let i = 0; i < 9; i++) first[`dist/old.${i}.js`] = 'old';
const big = 'n'.repeat(150 * 1024);

const redeploy = [
  '  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  14 to upload · 9 to delete · 30 unchanged                       2.1 MB',
  '',
  '  {gb}✓ Sealed up and delivered:{/} 14 files to ssh.example.com in 3.1 s.',
  '    {d}9 old files removed · https://example.com{/}',
];

// The job summary of the same redeploy (the page's card shows its heading and two tables).
const summaryHead = [
  '### ✅ Sealed up and delivered: 14 files to ssh.example.com in 3.1 s',
  '',
  '| Target | `sftp://deploy@ssh.example.com:22/home/site` |',
  '|---|---|',
  `| Host key | ED25519 \`${hostKeyFingerprint}\` verified |`,
  '| Site | https://example.com |',
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Uploaded | 14 | 2.1 MB |',
  '| Deleted | 9 | |',
  '| Unchanged | 30 | 30 KB |',
];

// The dry run (the page's CLI section): 2 new files, 2 changed, 2 gone, 41 unchanged.
const kib = (n: number): string => 'k'.repeat(n * 1024);
const before: Record<string, string> = {
  'dist/index.html': 'v1',
  'dist/about.html': 'v1',
  'dist/main.8b1e3d07.js': 'v1',
  'dist/admin/main.93c5b8e0.js': 'v1',
  'dist/admin/index.html': 'admin',
};
for (let i = 0; i < 40; i++) before[`dist/assets/f${i}.js`] = `asset ${i}`;

const dryRun = [
  ' {inv} DRY RUN {/} nothing will change on ssh.example.com',
  '  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  {b}Would upload 4 files{/}                                            424 KB',
  '    {g}+{/} admin/main.1b7e9f30.js                                        3 KB',
  '    {g}+{/} main.4f2a9c1e.js                                            412 KB',
  '    ~ about.html                                                    5 KB',
  '    ~ index.html                                                    4 KB',
  '  {b}Would delete 2 files{/}  {d}(sealup uploaded them; they are no longer in your build){/}',
  '    {r}-{/} admin/main.93c5b8e0.js',
  '    {r}-{/} main.8b1e3d07.js',
  '  41 unchanged',
  '',
  ' {inv} DRY RUN {/} nothing was changed. To apply: {b}sealup deploy ssh.example.com{/}',
];

describe("the home page's samples", () => {
  it('redeploys the shown config: the terminal screen and the job summary', async () => {
    const run = async (tty: boolean, extra = {}) => {
      const project = createProject(config, first);
      const server = createMemoryServer({ loginFolder: '/home/deploy' });
      const options = { cwd: project.root, tty, server, env: { ...env, ...extra } };
      await runMain(['deploy'], options);
      for (let i = 0; i < 5; i++) writeFileSync(join(project.root, `dist/page${i}.html`), big);
      for (let i = 0; i < 9; i++) {
        rmSync(join(project.root, `dist/old.${i}.js`));
        writeFileSync(join(project.root, `dist/new.${i}.js`), big);
      }
      return runMain(['deploy'], { ...options, clock: steppedClock(0, 3_100) });
    };
    const terminal = await run(true);
    expect(screenOf(terminal.stderr)).toBe(goldenText(redeploy, { color: true }));
    expect(terminal.stderr).toContain('14 / 14 files');
    expect(terminal.exitCode).toBe(0);
    const github = await run(false, inGitHub);
    expect(github.summary.startsWith(markdown(summaryHead))).toBe(true);
  });

  it('dry-runs the shown config: every change listed, nothing changed', async () => {
    const project = createProject(config, before);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const options = { cwd: project.root, server, env };
    await runMain(['deploy'], options);
    const at = (path: string): string => join(project.root, ...path.split('/'));
    writeFileSync(at('dist/index.html'), kib(4));
    writeFileSync(at('dist/about.html'), kib(5));
    writeFileSync(at('dist/main.4f2a9c1e.js'), kib(412));
    writeFileSync(at('dist/admin/main.1b7e9f30.js'), kib(3));
    rmSync(at('dist/main.8b1e3d07.js'));
    rmSync(at('dist/admin/main.93c5b8e0.js'));
    const files = server.files();
    const run = await runMain(['deploy', '--dry-run'], { ...options, tty: true });
    expect(run.stderr).toBe(goldenText(dryRun, { color: true }));
    expect(run.exitCode).toBe(0);
    expect(server.files()).toEqual(files);
  });
});
