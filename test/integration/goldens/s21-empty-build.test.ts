// Golden S21, "Empty build" (CLI page, docs/exploration/assets/06/scenarios-problems.js; notes
// goldens.md). `sealup deploy production`, exit 6. The build left public_html/ empty; sending it
// would delete the site, so sealup stops before connecting. No target block (ruling 3).
//
// Page form:
//   ✗ public_html/ is empty: sealup stopped before connecting.
//     An empty folder would delete the site: every file sealup put in www/.
//     Most likely the build failed or wrote its files somewhere else.
//     Run your build, check that it fills public_html/, then deploy again.
//     To send an empty folder on purpose: allow: [empty-source] on the target.
//
//     Nothing was changed on production.
//     More: sealup.dev/e/empty-source

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMemoryServer, goldenText } from '../../../src/testkit/index.ts';
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

// The page's server folder is www/ in the login folder.
const config = [
  'upload: public_html',
  'targets:',
  '  production:',
  '    server: sftp://deploy@ssh.example.com:22/~/www',
  `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
  `    hostKey: ${hostKeyLine}`,
  '    url: https://example.com',
  '',
].join('\n');

const s21 = [
  '  {rb}✗{/} {b}public_html/ is empty: sealup stopped before connecting.{/}',
  '    An empty folder would delete the site: every file sealup put in www/.',
  '    Most likely the build failed or wrote its files somewhere else.',
  '    Run your build, check that it fills public_html/, then deploy again.',
  '    {d}To send an empty folder on purpose: allow: [empty-source] on the target.{/}',
  '',
  '    Nothing was changed on production.',
  '    {d}More: sealup.dev/e/empty-source{/}',
];

// The JSON form (spec "--json object"; the page has none): blocked, no target block, so no
// target or server either; the error carries the slug and the same words as the terminal.
const s21json = {
  format: 1,
  version: '0.0.0-source',
  command: 'deploy',
  target: null,
  server: null,
  url: null,
  dryRun: false,
  status: 'blocked',
  exitCode: 6,
  uploaded: 0,
  written: 0,
  deleted: 0,
  unchanged: 0,
  bytes: 0,
  durationMs: 0,
  timings: { connect: 0, scan: 0, compare: 0, transfer: 0 },
  error: {
    code: 'empty-source',
    message: 'public_html/ is empty: sealup stopped before connecting.',
    fix: [
      'An empty folder would delete the site: every file sealup put in www/.',
      'Most likely the build failed or wrote its files somewhere else.',
      'Run your build, check that it fills public_html/, then deploy again.',
      'To send an empty folder on purpose: allow: [empty-source] on the target.',
    ].join('\n'),
    state: 'Nothing was changed on production.',
  },
};

type Run = Awaited<ReturnType<typeof runMain>>;

describe('S21: empty build', () => {
  let terminal: Run;
  let log: Run;
  let json: Run;
  let github: Run;
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  let before: ReturnType<typeof server.files>;
  beforeAll(async () => {
    // A site deployed before; then a build that wrote nothing.
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    const deployed = await runMain(['deploy', 'production'], { cwd: project.root, server });
    expect(deployed.exitCode).toBe(0);
    before = server.files();
    rmSync(join(project.root, 'public_html', 'index.html'));

    // A run that connects fails the test: runMain gets no server from here on.
    terminal = await runMain(['deploy', 'production'], { cwd: project.root, tty: true });
    log = await runMain(['deploy', 'production'], { cwd: project.root });
    json = await runMain(['deploy', 'production', '--json'], { cwd: project.root });
    github = await runMain(['deploy', 'production'], { cwd: project.root, env: inGitHub });
  });

  // The GitHub form (page S21 `ci`): the masks, the version line, the CI fix (the build step),
  // then the annotation at the `upload:` line (decision 31): line 1 of this fixture's config,
  // line 2 on the page, whose config starts with `server:`.
  it('prints the GitHub form: masks, the CI fix, one annotation', () => {
    const s21github = [
      ...canaryMasks,
      'sealup 0.0.0-source · deploy production',
      ...s21.slice(0, 3),
      '    Check the build step before sealup: it must fill public_html/.',
      ...s21.slice(4),
      '::error file=sealup.yml,line=1,title=Empty build folder::public_html/ is empty, and sending it would delete the site (www/ on production). The build probably failed or wrote elsewhere: check the build step. Nothing was changed on production.',
    ];
    expect(github.stderr).toBe(goldenText(s21github, { color: true }));
    expect(github.exitCode).toBe(6);
  });

  // The job summary (page S21 `summary`; spec #24 decision 32): the build step to check, then
  // the target table (R22) though sealup stopped before the target block: the summary is the one
  // place a reader of the run page sees which target it was.
  it('writes the job summary: the build step to check, then the target', () => {
    expect(github.summary).toBe(
      markdown([
        '### ❌ Empty build folder: nothing was changed on production',
        '',
        '> [!CAUTION]',
        '> `public_html/` is empty. Sending it would delete every file sealup put in `www/`. Most likely the build failed or wrote its files somewhere else.',
        '>',
        '> **Fix:** check the build step before sealup: it must fill `public_html/`.',
        '',
        '| Target | `sftp://deploy@ssh.example.com:22/~/www` |',
        '|---|---|',
        '| Host key | not checked: sealup stopped before connecting |',
        '| Site | https://example.com |',
        '',
        summaryFooter('empty-source'),
      ]),
    );
    expect(log.summary).toBe('');
  });

  it('prints the page lines in colour on a terminal, with no target block, and exits 6', () => {
    expect(terminal.stderr).toBe(goldenText(s21, { color: true }));
    expect(terminal.stdout).toBe('');
    expect(terminal.exitCode).toBe(6);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', () => {
    expect(log.stderr).toBe(
      goldenText(['sealup 0.0.0-source · deploy production', ...s21], { color: false }),
    );
    expect(log.exitCode).toBe(6);
  });

  it('prints one JSON object on stdout with --json, the human lines staying on stderr', () => {
    expect(JSON.parse(json.stdout)).toEqual(s21json);
    const jsonLog = ['sealup 0.0.0-source · deploy production', ...s21];
    expect(json.stderr).toBe(goldenText(jsonLog, { color: false }));
    expect(json.exitCode).toBe(6);
  });

  it('changes nothing on the server', () => {
    expect(server.files()).toEqual(before);
  });
});
