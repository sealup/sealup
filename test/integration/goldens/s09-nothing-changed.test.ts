// Golden S09, "Nothing changed" (CLI page, docs/exploration/assets/06/scenarios-start-daily.js;
// notes goldens.md). `sealup deploy production`, exit 0. Same lines, words, alignment, symbols and
// colours as the page; names, counts and times from this fixture. No plan line, no progress line.
//
// Page form (5,862 files, 3.0 s):
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   ✓ Already up to date: 5,862 files checked on production in 3.0 s.
//     https://example.com

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

// 1,001 files: enough for a thousands separator.
const files: Record<string, string> = {};
for (let i = 0; i < 1001; i++) files[`public_html/f${i}.html`] = `page ${i}`;

const s09 = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  {gb}✓ Already up to date:{/} 1,001 files checked on production in 3.0 s.',
  '    {d}https://example.com{/}',
];

// The log form (page S09 `ci`, without GitHub's masks; spec #24 decision 27): the version line
// first, the timing line after the result, without a transfer (nothing travelled).
const s09log = (): string[] => [
  'sealup 0.0.0-source · deploy production',
  ...s09,
  '    connect 0.0 s · scan 0.0 s · compare 0.0 s',
];

// The JSON form (spec "--json object"; the page has none): one object on stdout.
const s09json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: 'production',
  server: 'sftp://deploy@ssh.example.com:22/home/site',
  url: 'https://example.com',
  dryRun: false,
  status: 'unchanged',
  exitCode: 0,
  uploaded: 0,
  written: 0,
  deleted: 0,
  unchanged: 1001,
  bytes: 0,
  durationMs: 3_000,
  timings: { connect: 0, scan: 0, compare: 0, transfer: 0 },
};

// The job summary (page S09 `summary`; spec #24 decision 32): the heading, the target table, the
// counts (the unchanged files' size: 1,001 pages of 6 to 9 bytes, 7,899 bytes), the timing.
const s09summary = markdown([
  '### ✅ Already up to date: 1,001 files checked on production in 3.0 s',
  '',
  ...summaryTarget,
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Unchanged | 1,001 | 8 KB |',
  '',
  '**3.0 s** · connect 0.0 s · scan 0.0 s · compare 0.0 s',
  '',
  summaryFooter(),
]);

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S09: nothing changed', () => {
  let terminal: Run;
  let log: Run;
  let json: Run;
  let github: Run;
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  let before: ReturnType<typeof server.files>;
  beforeAll(async () => {
    const project = createProject(productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }), files);
    const options = { cwd: project.root, server };
    await runMain(['deploy', 'production'], options);
    before = server.files();
    const clock = steppedClock(0, 3_000);
    terminal = await runMain(['deploy', 'production'], { ...options, tty: true, clock });
    log = await runMain(['deploy', 'production'], { ...options, clock: steppedClock(0, 3_000) });
    json = await runMain(['deploy', 'production', '--json'], {
      ...options,
      clock: steppedClock(0, 3_000),
    });
    github = await runMain(['deploy', 'production'], {
      ...options,
      env: inGitHub,
      clock: steppedClock(0, 3_000),
    });
  });

  it('prints the page lines in colour on a terminal, with no progress line, and exits 0', () => {
    expect(terminal.stderr).toBe(goldenText(s09, { color: true }));
    expect(terminal.exitCode).toBe(0);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', () => {
    expect(log.stderr).toBe(goldenText(s09log(), { color: false }));
    expect(log.exitCode).toBe(0);
  });

  // The GitHub form (page S09 `ci`): the masks, then the log form; nothing changes, so no group.
  it('prints the GitHub form: masks, version line, colour, the timing line', () => {
    const s09github = [...canaryMasks, ...s09log()];
    expect(github.stderr).toBe(goldenText(s09github, { color: true }));
    expect(github.exitCode).toBe(0);
  });

  it('writes the job summary in the GitHub form only (spec #24 decision 32)', () => {
    expect(github.summary).toBe(s09summary);
    expect(log.summary).toBe('');
  });

  it('prints one JSON object on stdout with --json, the human lines staying on stderr', () => {
    expect(JSON.parse(json.stdout)).toEqual(s09json);
    expect(json.stderr).toBe(goldenText(s09log(), { color: false }));
    expect(json.exitCode).toBe(0);
  });

  it('changes nothing on the server, the manifest included', () => {
    expect(server.files()).toEqual(before);
  });
});
