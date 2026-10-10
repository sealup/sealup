// Golden S11, "Connection dropped, resumed" (CLI page, docs/exploration/assets/06/scenarios-start-
// daily.js; spec #41 decision 20). `sealup deploy production`, exit 0. Same lines, words,
// alignment, symbols and colours as the page; names, counts, sizes and times from this fixture.
// On a terminal the progress line is drawn, then replaced by the `!` line, drawn again from the
// files already in, then replaced by the blank line, so the screen ends as the page shows it.
//
// Page form (300 to upload, 5,562 unchanged, 3.4 MB, 5.1 s):
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   300 to upload · 5,562 unchanged                                 3.4 MB
//   «progress line, up to 182»
//   ! Connection lost after 182 of 300 files. Reconnecting (1 of 3)…
//     Reconnected. Resuming: 118 files left.
//   «progress line, from 182»
//
//   ✓ Sealed up and delivered: 300 files to production in 5.1 s.
//     reconnected once · https://example.com

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Connect } from '../../../src/contracts/index.ts';
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
import { expectFrozenJson } from '../../freeze-kit.ts';

// The fixture: 20 pages of 1 KiB that stay, and 300 vendor files of 11,884 bytes that a composer
// update changes: 3,565,200 bytes, which the page's units show as 3.4 MB.
const vendor = Array.from(
  { length: 300 },
  (_, i) => `vendor/lib-${String(i).padStart(3, '0')}.php`,
);
const files: Record<string, string> = {};
for (let i = 0; i < 20; i++) files[`public_html/page${i}.html`] = 'p'.repeat(1024);
for (const path of vendor) files[`public_html/${path}`] = 'a'.repeat(11_884);

const s11 = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  `${'  300 to upload · 20 unchanged'.padEnd(66)}3.4 MB`,
  '  {y}! Connection lost after 182 of 300 files. Reconnecting (1 of 3)…{/}',
  '    {d}Reconnected. Resuming: 118 files left.{/}',
  '',
  '  {gb}✓ Sealed up and delivered:{/} 300 files to production in 5.1 s.',
  '    {d}reconnected once · https://example.com{/}',
];

// The log form (page S11 `ci`, without GitHub's masks and group): the version line first, the
// timing line with the reconnect's time after the result. The transfer is under 5 s: no %.
const timing = '    connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s · reconnect 1.1 s';
const s11log = ['sealup 0.0.0-source · deploy production', ...s11, timing];

// The GitHub form (page S11 `ci`): the masks, the version line, the lines to the reconnect, the
// 300 changes in a group, the result, the timing line, then the notice.
const size = (path: string): string => `${' '.repeat(72 - 6 - path.length - 5)}12 KB`;
const s11github = [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  ...s11.slice(0, 6),
  '::group::Changes: 300 upload',
  ...vendor.map((path) => `    ~ ${path}${size(path)}`),
  '::endgroup::',
  ...s11.slice(6),
  timing,
  '::notice title=Reconnected once::The connection to ssh.example.com dropped after 182 of 300 files. sealup reconnected and sent the other 118; nothing is missing.',
];

// The job summary (page S11 `summary`): the counts, the NOTE box, the timing with the reconnect,
// the 300 changes.
const s11summary = markdown([
  '### ✅ Sealed up and delivered: 300 files to production in 5.1 s',
  '',
  ...summaryTarget,
  '',
  '| | Files | Size |',
  '|---|---:|---:|',
  '| Uploaded | 300 | 3.4 MB |',
  '| Unchanged | 20 | 20 KB |',
  '',
  '> [!NOTE]',
  '> The connection dropped after 182 of 300 files. sealup reconnected (1 of 3 tries) and sent the other 118; nothing is missing.',
  '',
  '**5.1 s** · connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s · reconnect 1.1 s',
  '',
  '<details><summary>Changes (300)</summary>',
  '',
  '```diff',
  ...vendor.map((path) => `~ ${path}`),
  '```',
  '',
  '</details>',
  '',
  summaryFooter(),
]);

// The JSON form (spec "--json object", decision 20: `reconnects` and `timings.reconnect`).
const s11json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: 'production',
  server: 'sftp://deploy@ssh.example.com:22/home/site',
  url: 'https://example.com',
  dryRun: false,
  status: 'ok',
  exitCode: 0,
  uploaded: 300,
  deleted: 0,
  unchanged: 20,
  bytes: 3_565_200,
  durationMs: 5_100,
  timings: { connect: 0, scan: 0, compare: 0, transfer: 0, reconnect: 1_100 },
  written: 0,
  reconnects: 1,
};

/**
 * The run's clock: 4.0 s for every reading after the start (as S08's), plus the time the
 * reconnect really waits (1 s before the first try) and its new login (0.1 s): 1.1 s in all.
 */
function pageTime(server: ReturnType<typeof createMemoryServer>) {
  let waited = 0;
  const stepped = steppedClock(0, 4_000);
  let connects = 0;
  const connect: Connect = async () => {
    if (connects++ > 0) waited += 100;
    return server.connect();
  };
  return {
    clock: () => stepped() + waited,
    wait: async (ms: number) => {
      waited += ms;
    },
    connect,
  };
}

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S11: connection dropped, resumed', () => {
  let terminal: Run;
  let log: Run;
  let json: Run;
  let github: Run;
  let server = createMemoryServer();
  beforeAll(async () => {
    const run = async (tty: boolean, flags: string[] = [], env = {}): Promise<Run> => {
      const config = `parallel: 1\n${productionConfig({ password: 'SEALUP_CANARY_PASSWORD' })}`;
      const project = createProject(config, files);
      server = createMemoryServer({ loginFolder: '/home/deploy', quick: true });
      await runMain(['deploy', 'production'], { cwd: project.root, server });
      for (const path of vendor)
        writeFileSync(join(project.root, 'public_html', path), 'b'.repeat(11_884));
      // One upload at a time: the lock's note is put 1, so the 183rd upload is put 184.
      server.faults.failWrite(184, 'connection-lost');
      return runMain(['deploy', 'production', ...flags], {
        cwd: project.root,
        tty,
        env,
        ...pageTime(server),
      });
    };
    terminal = await run(true);
    log = await run(false);
    json = await run(false, ['--json']);
    github = await run(false, [], inGitHub);
  });

  it('prints the GitHub form: the reconnect lines, the changes in a group, the notice', () => {
    expect(github.stderr).toBe(goldenText(s11github, { color: true }));
    expect(github.exitCode).toBe(0);
  });

  it('writes the job summary with a NOTE box and the reconnect time', () => {
    expect(github.summary).toBe(s11summary);
    expect(log.summary).toBe('');
  });

  it('prints the page lines in colour on a terminal, and exits 0', () => {
    expect(screenOf(terminal.stderr)).toBe(goldenText(s11, { color: true }));
    // Drawn again from the files already in: the next one after the reconnect is the 183rd.
    expect(terminal.stderr).toContain('183 / 300 files');
    expect(terminal.stderr).toContain('300 / 300 files');
    expect(terminal.exitCode).toBe(0);
  });

  it('prints the log form without colour, the timing line with the reconnect', () => {
    expect(log.stderr).toBe(goldenText(s11log, { color: false }));
    expect(log.exitCode).toBe(0);
  });

  it('prints one JSON object with the reconnects and the reconnect time', () => {
    expect(JSON.parse(json.stdout)).toEqual(s11json);
    expectFrozenJson('a reconnected run', json.stdout, 'json-reconnected.golden');
    expect(json.stderr).toBe(goldenText(s11log, { color: false }));
  });

  it('keeps every line within 80 columns but the timing line, the plan line ending at 72', () => {
    const lines = log.stderr.split('\n');
    expect(lines.find((line) => line.includes('to upload'))).toHaveLength(72);
    for (const line of lines.filter((text) => !text.includes('reconnect '))) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('leaves every file of the new build, recorded, and no temp name', () => {
    const site = [...server.files()].filter(([path]) => path.startsWith('/home/site/'));
    expect(site).toHaveLength(320);
    expect(site.some(([path]) => path.endsWith('.tmp'))).toBe(false);
    for (const [path, file] of site) {
      if (path.includes('/vendor/')) expect(file.bytes[0]).toBe('b'.charCodeAt(0));
    }
  });
});
