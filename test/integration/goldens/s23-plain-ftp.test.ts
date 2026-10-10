// Golden S23, "Plain FTP" (CLI page, docs/exploration/assets/06/scenarios-problems.js; spec #41
// decisions 10 and 11). `sealup deploy production` to an `ftp://` target, exit 0: the deploy works,
// and every run says once, in yellow and right after the target block, that the password travels
// in clear, with one fix and the measured speed gain. Over the real FTP transport, against the
// in-process FTP server (S08's redeploy fixture: the page's redeploy, with this fixture's counts).
//
// Page form (14 to upload, 9 to delete, 5,839 unchanged, 2.1 MB, 3.7 s):
//   production  ftp://deploy@ftp.example.com:21/www
//   host key    none (plain FTP has no host key)
//
//   ! Plain FTP: your password and files travel unencrypted.
//     Most hosts also offer SFTP: write sftp:// in server (sealup.yml line 15).
//     It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.
//
//   14 to upload · 9 to delete · 5,839 unchanged                    2.1 MB
//   «progress line»
//   ✓ Sealed up and delivered: 14 files to production in 3.7 s.
//     9 old files removed · https://example.com
//
// The page's terminal form has no blank line between the progress line and the result; S08 has
// one, and so does every run of sealup after its plan line: kept here, as S08 does.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canaries,
  createFtpServer,
  type FtpServer,
  goldenText,
  screenOf,
  steppedClock,
} from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  inGitHub,
  markdown,
  ref,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';
import { dialing } from '../../sftp-kit.ts';

/** The page's plain-FTP target: no hostKey (plain FTP has none), the server on line 4. */
const config = [
  'upload: public_html',
  'targets:',
  '  production:',
  '    server: ftp://deploy@ftp.example.com/www',
  `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
  '    url: https://example.com',
  '',
].join('\n');

// The first build: 30 files that stay, 5 pages that change, 9 hashed bundles that go.
const first: Record<string, string> = {};
for (let i = 0; i < 30; i++) first[`public_html/assets/u${i}.js`] = 'u'.repeat(1024);
for (let i = 0; i < 5; i++) first[`public_html/page${i}.html`] = 'v1';
for (let i = 0; i < 9; i++) first[`public_html/old.${i}.js`] = 'old';

// The second build: the 5 pages changed and 9 new bundles, 150 KiB each (2.1 MB).
const big = 'n'.repeat(150 * 1024);

const head = [
  '  production  ftp://deploy@ftp.example.com:21/www',
  '  host key    {d}none (plain FTP has no host key){/}',
  '',
  '  {y}!{/} {b}Plain FTP: your password and files travel unencrypted.{/}',
  '    Most hosts also offer SFTP: write sftp:// in server (sealup.yml line 4).',
  '    {d}It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.{/}',
];
const plan = '  14 to upload · 9 to delete · 30 unchanged                       2.1 MB';
const result = [
  '',
  '  {gb}✓ Sealed up and delivered:{/} 14 files to production in 3.1 s.',
  '    {d}9 old files removed · https://example.com{/}',
];
const s23 = [...head, '', plan, ...result];

// The log forms (page S23 `ci`): the version line first, the timing line after the result. The
// page's CI log has no `FTP, 4 connections` (its job summary has).
const timing = '    connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s';
const s23log = ['sealup 0.0.0-source · deploy production', ...s23, timing];

// The GitHub form: the warning's annotation right after its lines, at the server's line (page).
const size = (path: string): string => `${' '.repeat(72 - 6 - path.length - 6)}150 KB`;
const nine = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const s23github = [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  ...head,
  '::warning file=sealup.yml,line=4,title=Plain FTP::Your password and files travel unencrypted to ftp.example.com. Most hosts also offer SFTP: write sftp:// in server. It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.',
  '',
  plan,
  '::group::Changes: 14 upload, 9 delete',
  ...nine.map((i) => `    {g}+{/} new.${i}.js${size(`new.${i}.js`)}`),
  ...[0, 1, 2, 3, 4].map((i) => `    ~ page${i}.html${size(`page${i}.html`)}`),
  ...nine.map((i) => `    {r}-{/} old.${i}.js`),
  '::endgroup::',
  ...result,
  timing,
];

// The job summary (page S23 `summary`): ⚠️ and "over plain FTP" in the heading, the WARNING box
// before the target table, the host key row, and `FTP, 4 connections` ending the timing line.
const s23summary = markdown([
  '### ⚠️ Sealed up and delivered: 14 files to production in 3.1 s, over plain FTP',
  '',
  '> [!WARNING]',
  '> **Plain FTP:** your password and files travel unencrypted.',
  '> Most hosts also offer SFTP: write `sftp://` in `server` (sealup.yml line 4). It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.',
  '',
  '| Target | `ftp://deploy@ftp.example.com:21/www` |',
  '|---|---|',
  '| Host key | none (plain FTP has no host key) |',
  '| Site | https://example.com |',
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Uploaded | 14 | 2.1 MB |',
  '| Deleted | 9 | |',
  '| Unchanged | 30 | 30 KB |',
  '',
  '**3.1 s** · connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s · FTP, 4 connections',
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

// The JSON form (spec #41 decision 11; the page has none): the warning in `warnings`, after the
// keys the first version printed (0026 point 4), in the terminal's words.
const s23json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: 'production',
  server: 'ftp://deploy@ftp.example.com:21/www',
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
  warnings: [
    {
      code: 'plain-ftp',
      message: 'Plain FTP: your password and files travel unencrypted.',
      fix: [
        'Most hosts also offer SFTP: write sftp:// in server (sealup.yml line 4).',
        'It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.',
      ].join('\n'),
    },
  ],
};

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S23: plain FTP', () => {
  let terminal: Run;
  let log: Run;
  let json: Run;
  let github: Run;
  let firstRun: Run;
  let ftp: FtpServer;
  const servers: FtpServer[] = [];
  beforeAll(async () => {
    const run = async (tty: boolean, flags: string[] = [], env = {}): Promise<Run> => {
      const project = createProject(config, first);
      ftp = await createFtpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
      servers.push(ftp);
      const options = { cwd: project.root, tty, connect: dialing(ftp) };
      firstRun = await runMain(['deploy', 'production'], options);
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
  afterAll(async () => {
    for (const server of servers) await server.stop();
  });

  it('prints the page lines in colour on a terminal, the warning after the target block', () => {
    expect(screenOf(terminal.stderr)).toBe(goldenText(s23, { color: true }));
    expect(terminal.exitCode).toBe(0);
  });

  it('prints the log form without colour when not a terminal', () => {
    expect(log.stderr).toBe(goldenText(s23log, { color: false }));
    expect(log.exitCode).toBe(0);
  });

  it('prints the GitHub form: the warning, then its annotation at the server line', () => {
    expect(github.stderr).toBe(goldenText(s23github, { color: true }));
    expect(github.exitCode).toBe(0);
  });

  it('writes the job summary: the WARNING box, and FTP with its connections in the timing', () => {
    expect(github.summary).toBe(s23summary);
  });

  it('gives the warning in --json, the human lines staying on stderr', () => {
    expect(JSON.parse(json.stdout)).toEqual(s23json);
    expect(json.stderr).toBe(goldenText(s23log, { color: false }));
    expect(json.exitCode).toBe(0);
  });

  it('warns on every run, the first deploy too', () => {
    expect(firstRun.stderr).toContain('Plain FTP: your password and files travel unencrypted.');
    expect(firstRun.exitCode).toBe(0);
  });

  it('leaves the new build on the FTP server, and nothing of the old one', () => {
    const site = [...ftp.files().keys()].filter((path) => path.startsWith('/www/'));
    expect(site).toHaveLength(44);
    expect(site.some((path) => path.includes('/old.'))).toBe(false);
  });
});
