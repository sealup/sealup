// Golden S25, "sealup pull in CI" (CLI page, docs/exploration/assets/06/scenarios-problems.js).
// `sealup pull production` without a terminal, exit 2: refused right after reading sealup.yml,
// before any variable or connection (0002, 0023 §7, spec #24 decision 25). The CI form is the
// real one; the terminal form (stderr a terminal, stdin piped) repeats it. The job summary and
// the annotation are the page's.
//
// Page form:
//   ✗ sealup pull does not run in CI.
//     It copies server files to the machine it runs on, and a CI runner is
//     thrown away when the job ends, so the files would go with it.
//     Run it on your own machine:  sealup pull production
//
//     Nothing was downloaded. Nothing was changed on production.
//     More: sealup.dev/e/pull-in-ci

import { beforeAll, describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  hostKeyLine,
  inGitHub,
  markdown,
  ref,
  runMain,
  summaryFooter,
  versionLine,
} from '../../deploy-kit.ts';

const config = [
  'upload: public_html',
  'pull:',
  '  www/resources: public_html/resources',
  'targets:',
  '  production:',
  '    server: sftp://deploy@ssh.example.com:22/home/site',
  `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
  `    hostKey: ${hostKeyLine}`,
  '    url: https://example.com',
  '  staging:',
  '    server: sftp://deploy@203.0.113.10/srv/site',
  `    password: ${ref('STAGING_PASSWORD')}`,
  '',
].join('\n');

const s25 = [
  '  {rb}✗{/} {b}sealup pull does not run in CI.{/}',
  '    It copies server files to the machine it runs on, and a CI runner is',
  '    thrown away when the job ends, so the files would go with it.',
  '    Run it on your own machine:  sealup pull production',
  '',
  '    Nothing was downloaded. Nothing was changed on production.',
  '    {d}More: sealup.dev/e/pull-in-ci{/}',
];

type Run = Awaited<ReturnType<typeof runMain>>;

const project = (): string => createProject(config, { 'public_html/index.html': 'x' }).root;

describe('S25: sealup pull in CI', () => {
  let terminal: Run;
  let log: Run;
  let github: Run;
  let json: Run;
  beforeAll(async () => {
    const root = project();
    // No server: a run that connects fails the test. No keys: a run that asks fails too.
    terminal = await runMain(['pull', 'production'], { cwd: root, tty: true, stdinTTY: false });
    log = await runMain(['pull', 'production'], { cwd: root });
    github = await runMain(['pull', 'production'], { cwd: root, env: inGitHub });
    json = await runMain(['pull', 'production', '--json'], { cwd: root });
  });

  it('prints the page lines in a log after the version line, exit 2', () => {
    expect(log.stderr).toBe(
      goldenText([versionLine('pull', 'production'), ...s25], { color: false }),
    );
    expect(log.exitCode).toBe(2);
  });

  it('prints the GitHub form: masks, the version line, the words, one annotation', () => {
    expect(github.stderr).toBe(
      goldenText(
        [
          ...canaryMasks,
          versionLine('pull', 'production'),
          ...s25,
          '::error title=pull does not run in CI::sealup pull copies server files to the machine it runs on, and a CI runner is thrown away when the job ends. Run sealup pull production on your own machine.',
        ],
        { color: true },
      ),
    );
    expect(github.exitCode).toBe(2);
  });

  // The page's summary, byte for byte; the file ends with a line break, as every summary here.
  it('writes the job summary: the cause, the fix, the target', () => {
    expect(github.summary).toBe(
      markdown([
        '### ❌ sealup pull does not run in CI: nothing was changed on production',
        '',
        '> [!CAUTION]',
        '> `sealup pull` copies server files to the machine it runs on, and a CI runner is thrown away when the job ends, so the files would go with it.',
        '>',
        '> **Fix:** remove `sealup pull` from the workflow and run `sealup pull production` on your own machine.',
        '',
        '| Target | `sftp://deploy@ssh.example.com:22/home/site` |',
        '|---|---|',
        '| Host key | not checked: sealup stopped before connecting |',
        '| Site | https://example.com |',
        '',
        summaryFooter('pull-in-ci'),
      ]),
    );
  });

  it('repeats the words on a terminal whose input is not one, in colour', () => {
    expect(terminal.stderr).toBe(goldenText(s25, { color: true }));
    expect(terminal.exitCode).toBe(2);
  });

  it('gives the JSON object of a pull: command pull, nothing downloaded, the error', () => {
    expect(JSON.parse(json.stdout)).toEqual({
      format: 1,
      version: '0.0.0-source',
      command: 'pull',
      target: null,
      server: null,
      url: null,
      dryRun: false,
      status: 'failed',
      exitCode: 2,
      downloaded: 0,
      unchanged: 0,
      bytes: 0,
      durationMs: 0,
      timings: { connect: 0, scan: 0, compare: 0, transfer: 0 },
      error: {
        code: 'pull-in-ci',
        message: 'sealup pull does not run in CI.',
        fix: [
          'It copies server files to the machine it runs on, and a CI runner is',
          'thrown away when the job ends, so the files would go with it.',
          'Run it on your own machine:  sealup pull production',
        ].join('\n'),
        state: 'Nothing was downloaded. Nothing was changed on production.',
      },
    });
    expect(json.exitCode).toBe(2);
  });

  it('is refused before the variables: an unset one does not change the words', async () => {
    // STAGING_PASSWORD is not set: staging cannot be used, and the refusal comes first.
    const run = await runMain(['pull', 'staging'], { cwd: project() });
    expect(run.stderr).toContain('✗ sealup pull does not run in CI.');
    expect(run.stderr).toContain('Run it on your own machine:  sealup pull staging');
    expect(run.stderr).not.toContain('STAGING_PASSWORD');
    expect(run.exitCode).toBe(2);
  });

  it('names no target when none was named and several exist', async () => {
    const run = await runMain(['pull'], { cwd: project() });
    expect(run.stderr).toContain('Run it on your own machine:  sealup pull\n');
    expect(run.stderr).toContain('Nothing was downloaded. Nothing was changed.\n');
    expect(run.exitCode).toBe(2);
  });
});
