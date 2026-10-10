// Golden S06, "Check the config offline" (CLI page, docs/exploration/assets/06/scenarios-start-daily.js).
// `sealup check`, exit 0: one line per check in the page's order; a variable missing for one
// target is a warning for that target only; variable names and where they come from, never a
// value (spec #24 decision 14, R6). Nothing connects: runMain has no server.
//
// Adapted, each from this version's limits or the fixture:
// - STAGING_KEY's line is this fixture's, 16 (the page's config has it on 21).
// - A `Login:` line after the variables says how each target logs in (decision 0033, plan 05
//   T06: `check` says which of password and privateKey a target uses); the page has none.
// - In GitHub's form APP_ENV holds the canary password's value, so the mask lines are the
//   password's (the same forms are masked once).
// - The file counts are this fixture's (2 and 2; the page shows 1,322 and 4,540): the smallest
//   tree that still shows each folder counted without its excluded files.
// - The last line names the target: with two targets `sealup deploy -n` alone stops with exit 2
//   (target-not-named), so the command to copy is `sealup deploy -n production`.
//
// Page form (terminal):
//   ✓ sealup.yml is valid
//   ✓ 2 targets: production, staging
//   ✓ Upload folders exist: public_html/ (1,322 files), api/ (4,540 files)
//   ✓ Variables set: PROD_PASSWORD, APP_ENV  (from sealup.env)
//   ! STAGING_KEY is not set. Only staging needs it: targets.staging.privateKey
//   ✓ Host keys saved for production and staging
//
//   ✓ Ready to deploy to production. staging needs STAGING_KEY first.
//     Checked offline. A dry run also checks the server: sealup deploy -n

import { describe, expect, it } from 'vitest';
import { canaries, goldenText } from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  inGitHub,
  runMain,
  twoTargetConfig,
} from '../../deploy-kit.ts';
import { expectFrozenJson } from '../../freeze-kit.ts';

const s06 = (from: string) => [
  '  {g}✓{/} sealup.yml is valid',
  '  {g}✓{/} 2 targets: production, staging',
  '  {g}✓{/} Upload folders exist: public_html/ (2 files), api/ (2 files)',
  `  {g}✓{/} Variables set: PROD_PASSWORD, APP_ENV  {d}(from ${from}){/}`,
  '  {y}!{/} STAGING_KEY is not set. Only staging needs it: targets.staging.privateKey',
  '  {g}✓{/} Login: production with a password, staging with a private key',
  '  {g}✓{/} Host keys saved for production and staging',
  '',
  '  {gb}✓ Ready to deploy to production.{/} staging needs STAGING_KEY first.',
  '    {d}Checked offline. A dry run also checks the server: sealup deploy -n production{/}',
];

// The GitHub form (page S06 `ci`): the masks of the password first (here the canary, so the leak
// check proves the value is nowhere else), the version line, the same checks with the variable
// from the environment, then the warning as an annotation at staging's password line.
const s06github = [
  ...canaryMasks,
  'sealup 0.0.0-source · check',
  ...s06('the environment'),
  '::warning file=sealup.yml,line=16,title=STAGING_KEY not set::Only staging needs it: targets.staging.privateKey.',
];

const build = {
  'public_html/index.html': '<h1>home</h1>',
  'public_html/app.js': 'app()',
  'public_html/resources/upload.jpg': 'jpg',
  'api/index.php': '<?php',
  'api/routes.php': '<?php',
  'api/storage/log.txt': 'log',
  'api/.env': 'APP_KEY=local',
};

function project(withEnvFile: boolean): string {
  const envFile = withEnvFile
    ? { 'sealup.env': 'PROD_PASSWORD=pw-from-env-file\nAPP_ENV="APP_ENV=production\\nAPP_KEY=x"\n' }
    : {};
  return createProject(twoTargetConfig({ write: true }), { ...build, ...envFile }).root;
}

describe('S06: check the config offline', () => {
  it('prints the page lines in colour on a terminal, the variable from sealup.env, exit 0', async () => {
    // No server: a run that connects fails the test.
    const run = await runMain(['check'], { cwd: project(true), tty: true });
    expect(run.stderr).toBe(goldenText(s06('sealup.env'), { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(0);
  });

  it('prints the log form: the version line first, no colour', async () => {
    const run = await runMain(['check'], { cwd: project(true) });
    const s06log = ['sealup 0.0.0-source · check', ...s06('sealup.env')];
    expect(run.stderr).toBe(goldenText(s06log, { color: false }));
    expect(run.exitCode).toBe(0);
  });

  it('prints the GitHub form: masks, the environment, the warning as an annotation', async () => {
    const password = canaries.SEALUP_CANARY_PASSWORD;
    const env = { ...inGitHub, PROD_PASSWORD: password, APP_ENV: password };
    const run = await runMain(['check'], { cwd: project(false), env });
    expect(run.stderr).toBe(goldenText(s06github, { color: true }));
    expect(run.exitCode).toBe(0);
  });

  it('gives --json: command check, each target ready or not with its missing variables', async () => {
    const run = await runMain(['check', '--json'], { cwd: project(true) });
    expectFrozenJson('sealup check (S06)', run.stdout, 'json-check.golden');
    expect(run.exitCode).toBe(0);
  });
});
