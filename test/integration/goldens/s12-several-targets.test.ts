// Golden S12, "Several targets, none named" (CLI page, docs/exploration/assets/06/
// scenarios-problems.js; spec #24 decisions 15-16). `sealup deploy`, two targets and no name. On
// a terminal sealup asks once, deploys as usual and ends with the command that skips the
// question (exit 0); without one it never asks, and names the exact fix (exit 2).
//
// Page form (terminal):
//   Deploy to which target?
//     ✓ staging
//
//     staging     ssh://deploy@203.0.113.10:22/srv/site
//     host key    SHA256:bC7uLZkjb77MEr9JKr2caj5ELzomW9uOdt/MISsP5r4  verified
//     transfer    changed files travel as one archive over SSH
//
//     10 to upload · 10 to delete · 5,852 unchanged                   5.0 MB
//     «progress line»
//     ✓ Sealed up and delivered: 10 files to staging in 3.5 s.
//       10 old files removed
//       Next time, skip the question: sealup deploy staging
//
// Adapted, each on purpose:
// - Staging is on `ssh://` as on the page; its memory server carries the archive, so the block
//   has the page's `transfer` line (0034, spec #41 decision 18). Both targets use this fixture's
//   host key (one key, its fingerprint).
// - The picker's options show each server as written in sealup.yml (decision 15), here without
//   the port, as the page's hints; the target block prints the port (R22).
// - A blank line comes before the result, where the progress line was: the product's layout
//   since S07 (a result after a plan line); the page's S12 leaves it out.
// - Counts, sizes and times from this fixture: 5 unchanged files, 10 new ones of 512 KiB.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
  hostKeyLine,
  inGitHub,
  markdown,
  ref,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';

const down = '\u001b[B';
const enter = '\r';

// Two targets, both reading the canary: their masks are the same lines, given once.
const config = [
  'upload: public_html',
  'targets:',
  '  production:',
  '    server: sftp://deploy@ssh.example.com/home/site',
  `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
  `    hostKey: ${hostKeyLine}`,
  '  staging:',
  '    server: ssh://deploy@203.0.113.10/srv/site',
  `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
  `    hostKey: ${hostKeyLine}`,
  '',
].join('\n');

// The first build: 5 files that stay, 10 that go.
const first: Record<string, string> = {};
for (let i = 0; i < 5; i++) first[`public_html/keep${i}.html`] = 'kept';
for (let i = 0; i < 10; i++) first[`public_html/old.${i}.js`] = 'old';

/**
 * A project deployed once to staging, then built again: the 10 old files gone, 10 new bundles of
 * 512 KiB (the page's units show 5.0 MB). Its connect reaches staging only.
 */
async function rebuiltProject() {
  // Logged in under /srv, so the target folder /srv/site can be made.
  const staging = createMemoryServer({ loginFolder: '/srv/deploy', archive: true });
  const connect: Connect = async (target) => {
    if (target.name !== 'staging') throw new Error(`the run connected to ${target.name}`);
    return staging.connect();
  };
  const project = createProject(config, first);
  const before = await runMain(['deploy', 'staging'], { cwd: project.root, connect });
  expect(before.exitCode).toBe(0);
  for (let i = 0; i < 10; i++) {
    rmSync(join(project.root, `public_html/old.${i}.js`));
    writeFileSync(join(project.root, `public_html/new.${i}.js`), 'n'.repeat(512 * 1024));
  }
  return { root: project.root, connect, staging };
}

const s12 = [
  'Deploy to which target?',
  '  {g}✓{/} staging',
  '',
  '  staging     ssh://deploy@203.0.113.10:22/srv/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '  transfer    changed files travel as one archive over SSH',
  '',
  '  10 to upload · 10 to delete · 5 unchanged                       5.0 MB',
  '',
  '  {gb}✓ Sealed up and delivered:{/} 10 files to staging in 3.5 s.',
  '    {d}10 old files removed{/}',
  '    {d}Next time, skip the question: sealup deploy staging{/}',
];

// The picker as it waits (the page's runPicker): `›` and the label bold on the selected option,
// each server dim, three spaces after the longest name.
const picker = [
  'Deploy to which target?',
  '{gb}  › {/}{b}production{/}   {d}sftp://deploy@ssh.example.com/home/site{/}',
  '    staging      {d}ssh://deploy@203.0.113.10/srv/site{/}',
];

// Esc or Ctrl-C: the options are erased, and nothing is done (exit 130). The page has no such
// screen; the words are the cancelled problem's (spec #24 decision 8).
const cancelled = [
  'Deploy to which target?',
  '  {rb}✗{/} {b}Stopped: no target was chosen.{/}',
  '',
  '    Nothing was changed.',
  '    {d}More: sealup.dev/e/cancelled{/}',
];

// Without a terminal (page S12 `ci`): never a question; every command that works. A plain log
// may be a laptop's pipe, so it says why sealup did not ask instead of naming CI (as T27's
// log forms keep the terminal's words).
const words = (why: string): string[] => [
  '  {rb}✗{/} {b}Which target? sealup.yml has 2 and none was named.{/}',
  `    ${why} Name the target in the command:`,
  '      sealup deploy production',
  '      sealup deploy staging',
];
const end = ['', '    Nothing was changed.', '    {d}More: sealup.dev/e/target-not-named{/}'];

describe('S12: several targets, none named, on a terminal', () => {
  it('draws the page picker: the cursor on the first target, each server dim', async () => {
    const project = createProject(config, first);
    // Esc after the first drawing; no server: a run that connects fails the test.
    const run = await runMain(['deploy'], { cwd: project.root, tty: true, keys: ['\u001b'] });
    const drawn = run.stderr.slice(0, run.stderr.indexOf('\u001b[2A'));
    expect(screenOf(drawn)).toBe(goldenText(picker, { color: true }));
  });

  it.each([
    ['Esc', '\u001b'],
    ['Ctrl-C', '\u0003'],
  ])('stops on %s with exit 130, nothing done', async (_, key) => {
    const project = createProject(config, first);
    const run = await runMain(['deploy'], { cwd: project.root, tty: true, keys: [down, key] });
    expect(screenOf(run.stderr)).toBe(goldenText(cancelled, { color: true }));
    expect(run.exitCode).toBe(130);
  });

  it('asks with a picker, deploys the target picked, and shows how to skip the question', async () => {
    const { root, connect, staging } = await rebuiltProject();
    const run = await runMain(['deploy'], {
      cwd: root,
      tty: true,
      keys: [down, enter],
      connect,
      clock: steppedClock(0, 3_500),
    });
    expect(screenOf(run.stderr)).toBe(goldenText(s12, { color: true }));
    expect(run.exitCode).toBe(0);
    expect([...staging.files().keys()].filter((path) => path.includes('/new.'))).toHaveLength(10);
  });

  it('never asks when stdin is not a terminal (a pipe): it stops as without one', async () => {
    const project = createProject(config, first);
    const run = await runMain(['deploy'], { cwd: project.root, tty: true, stdinTTY: false });
    const s12 = [...words('sealup asks only on a terminal.'), ...end];
    expect(run.stderr).toBe(goldenText(s12, { color: true }));
    expect(run.exitCode).toBe(2);
  });
});

describe('S12: several targets, none named, without a terminal', () => {
  const deploy = (env = {}) => {
    const project = createProject(config, first);
    return runMain(['deploy'], { cwd: project.root, env });
  };

  it('prints the log form: the version line, the commands to type, exit 2', async () => {
    const run = await deploy();
    const s12log = [
      'sealup 0.0.0-source · deploy',
      ...words('sealup asks only on a terminal.'),
      ...end,
    ];
    expect(run.stderr).toBe(goldenText(s12log, { color: false }));
    expect(run.exitCode).toBe(2);
  });

  // The GitHub form (page S12 `ci`): CI's words, the action's input, and the annotation.
  it("prints the GitHub form: masks, CI's words with the action's input, one annotation", async () => {
    const run = await deploy(inGitHub);
    const s12github = [
      ...canaryMasks,
      'sealup 0.0.0-source · deploy',
      ...words('In CI sealup never asks.'),
      '    With the GitHub action, set its target input:  target: production',
      ...end,
      "::error title=No target named::sealup.yml has 2 targets (production, staging) and none was named. Set the action's target input, or run sealup deploy production or sealup deploy staging.",
    ];
    expect(run.stderr).toBe(goldenText(s12github, { color: true }));
    expect(run.exitCode).toBe(2);
  });

  // The job summary (page S12 `summary`; spec #24 decision 32): no target was chosen, so no
  // target table. The file ends with a line break, which the page's text leaves out.
  it('writes the job summary: the caution box with the action input in a yaml block', async () => {
    const run = await deploy(inGitHub);
    expect(run.summary).toBe(
      markdown([
        '### ❌ No target named: nothing was changed',
        '',
        '> [!CAUTION]',
        '> `sealup.yml` has 2 targets, `production` and `staging`, and this step did not name one. In CI sealup never asks.',
        '>',
        "> **Fix:** set the action's `target` input:",
        '>',
        '> ```yaml',
        '> with:',
        '>   target: production',
        '> ```',
        '>',
        '> or run `sealup deploy production` / `sealup deploy staging`.',
        '',
        summaryFooter('target-not-named'),
      ]),
    );
  });
});
