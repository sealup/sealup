// Golden S05, "Help for this project" (CLI page, docs/exploration/assets/06/scenarios-start-daily.js).
// `sealup` alone in a project with two targets, exit 0: the exact commands with the real target
// names, each deploy line naming the target's `url`, else its host. Same text in CI: it only
// reads sealup.yml (spec #24 decision 12). On stdout, like `sealup help`.
//
// Adapted: the fixture is the page's typical config as this version reads it (twoTargetConfig:
// staging over sftp://), with its `pull:` entry. The "Copy user uploads to this machine" block
// names the first target only, as the page does, though both share the entry; a config without
// `pull:` has no such block. STAGING_PASSWORD is not set: a target whose variable is missing is
// still listed (sealup alone checks nothing).
//
// Page form:
//   sealup 0.1.0 · sealup.yml · 2 targets: production, staging
//
//   Deploy
//     sealup deploy production             send changes to https://example.com
//     sealup deploy staging                send changes to 203.0.113.10
//     sealup deploy --dry-run production   dry run: list every change, change nothing
//
//   Copy user uploads to this machine
//     sealup pull production               www/resources → public_html/resources
//
//   Check
//     sealup check                         sealup.yml and its variables, offline
//
//   All commands, config keys and exit codes: sealup help

import { describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  productionConfig,
  runMain,
  twoTargetConfig,
} from '../../deploy-kit.ts';

const s05 = [
  '  sealup 0.0.0-source · sealup.yml · 2 targets: production, staging',
  '',
  '  {b}Deploy{/}',
  '    sealup deploy production             send changes to https://example.com',
  '    sealup deploy staging                send changes to 203.0.113.10',
  '    sealup deploy --dry-run production   dry run: list every change, change nothing',
  '',
  '  {b}Copy user uploads to this machine{/}',
  '    sealup pull production               www/resources → public_html/resources',
  '',
  '  {b}Check{/}',
  '    sealup check                         sealup.yml and its variables, offline',
  '',
  '  All commands, config keys and exit codes: sealup help',
];

const env = { PROD_PASSWORD: 'pw-for-tests' };

function project(config = twoTargetConfig({ pull: true })): string {
  return createProject(config, { 'public_html/index.html': 'x', 'api/index.php': 'x' }).root;
}

describe('S05: help for this project', () => {
  it('prints the page lines on a terminal, on stdout, exit 0', async () => {
    // No server: a run that connects fails the test.
    const run = await runMain([], { cwd: project(), tty: true, env });
    expect(run.stdout).toBe(goldenText(s05, { color: true }));
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
  });

  it('prints the same text in a log and in GitHub, without colour', async () => {
    for (const ci of [{}, inGitHub]) {
      const run = await runMain([], { cwd: project(), env: { ...env, ...ci } });
      expect(run.stdout).toBe(goldenText(s05, { color: false }));
      expect(run.stderr).toBe('');
      expect(run.exitCode).toBe(0);
    }
  });

  it('gives the commands without a name for the only target', async () => {
    const run = await runMain([], { cwd: project(productionConfig()), env });
    expect(run.stdout).toBe(
      goldenText(
        [
          '  sealup 0.0.0-source · sealup.yml · 1 target: production',
          '',
          '  {b}Deploy{/}',
          '    sealup deploy                 send changes to https://example.com',
          '    sealup deploy --dry-run       dry run: list every change, change nothing',
          '',
          '  {b}Check{/}',
          '    sealup check                  sealup.yml and its variables, offline',
          '',
          '  All commands, config keys and exit codes: sealup help',
        ],
        { color: false },
      ),
    );
  });

  it('lists each pull entry under the one command, and names no target for the only one', async () => {
    const config = productionConfig().replace(
      'targets:',
      'pull:\n  www/resources: public_html/resources\n  .: backup/site\ntargets:',
    );
    const run = await runMain([], { cwd: project(config), env });
    expect(run.stdout.split('\n').slice(6, 10)).toEqual([
      '  Copy user uploads to this machine',
      '    sealup pull                   www/resources → public_html/resources',
      '                                  . → backup/site',
      '',
    ]);
  });

  it('repeats -c in every command, so each one can be copied', async () => {
    const root = createProject('', {
      'site/sealup.yml': productionConfig(),
      'site/public_html/index.html': 'x',
    }).root;
    const run = await runMain(['-c', 'site/sealup.yml'], { cwd: root, env });
    expect(run.stdout.split('\n').slice(0, 5)).toEqual([
      '  sealup 0.0.0-source · site/sealup.yml · 1 target: production',
      '',
      '  Deploy',
      '    sealup deploy -c site/sealup.yml             send changes to https://example.com',
      '    sealup deploy --dry-run -c site/sealup.yml   dry run: list every change, change nothing',
    ]);
    expect(run.exitCode).toBe(0);
  });
});
