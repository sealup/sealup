// `sealup check [target]` through main() (spec #24 decision 14): offline (no run here has a
// server: one that connects fails the test), the exit code a deploy would give before
// connecting, a target's problem a warning without a name, never a value (runMain's leak check).
// S06 itself is goldens/s06-check.test.ts.

import { describe, expect, it } from 'vitest';
import {
  createProject,
  inGitHub,
  productionConfig,
  ref,
  runMain,
  twoTargetConfig,
  versionLine,
} from '../deploy-kit.ts';

const build = { 'public_html/index.html': 'x', 'api/index.php': 'x' };
const both = { PROD_PASSWORD: 'pw-for-tests', STAGING_KEY: 'key-for-staging' };

function project(config = twoTargetConfig(), files: Record<string, string> = build): string {
  return createProject(config, files).root;
}

/** The two-target config with production's hostKey line taken out. */
const noProductionKey = twoTargetConfig()
  .split('\n')
  .filter((line, i) => !(i === 9 && line.startsWith('    hostKey:')))
  .join('\n');

describe('sealup check [target]', () => {
  it('checks the named target only; ready is exit 0', async () => {
    const run = await runMain(['check', 'production'], { cwd: project(), env: both });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('✓ Target: production\n');
    expect(run.stderr).toContain('✓ Variables set: PROD_PASSWORD  (from the environment)\n');
    expect(run.stderr).not.toContain('STAGING');
    expect(run.stderr).toContain(
      'Checked offline. A dry run also checks the server: sealup deploy --dry-run production\n',
    );
  });

  it('makes a named target’s missing variable an error: its words, exit 2', async () => {
    const run = await runMain(['check', 'staging'], {
      cwd: project(),
      env: { PROD_PASSWORD: 'x'.repeat(8) },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('  ✗ STAGING_KEY is not set: targets.staging.privateKey\n');
    expect(run.stderr).toContain(
      `  ✗ STAGING_KEY is not set.\n    targets.staging.privateKey (sealup.yml line 14) reads ${ref('STAGING_KEY')}.\n`,
    );
    expect(run.stderr).not.toContain('Ready to deploy');
  });

  it('answers a target not in the file with did-you-mean for check, exit 2', async () => {
    const run = await runMain(['check', 'stagin'], { cwd: project(), env: both });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.split('\n').slice(0, 3)).toEqual([
      versionLine('check', 'stagin'),
      '  ✗ No target named stagin in sealup.yml.',
      '    Did you mean staging?  sealup check staging',
    ]);
  });

  it('gives exit 4 for a target without a host key', async () => {
    const run = await runMain(['check', 'production'], {
      cwd: project(noProductionKey),
      env: both,
    });
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain(
      '  ✗ No host key saved for production. Run: sealup keyscan production\n',
    );
    expect(run.stderr).toContain(
      '  ✗ sealup cannot confirm this server is yours: there is no host key.\n',
    );
  });

  it('runs the safety nets that need no server: a missing build folder is exit 6', async () => {
    const run = await runMain(['check'], { cwd: project(productionConfig(), {}), env: both });
    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain(
      '  ✗ public_html does not exist: sealup stopped before connecting.\n',
    );
  });

  it('warns for one target and stays exit 0 while another is ready', async () => {
    const run = await runMain(['check'], { cwd: project(noProductionKey), env: both });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      '  ! No host key saved for production. Run: sealup keyscan production\n',
    );
    expect(run.stderr).toContain(
      '  ✓ Ready to deploy to staging. production needs a host key first.\n',
    );
    expect(run.stderr).toContain('sealup deploy --dry-run staging\n');
  });

  it('gives the first target’s code when no target is ready', async () => {
    const run = await runMain(['check'], { cwd: project(noProductionKey), env: {} });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      '  ! PROD_PASSWORD is not set. Only production needs it: targets.production.password\n',
    );
    expect(run.stderr).toContain('  ✗ PROD_PASSWORD is not set.\n');
  });

  it('stops on an invalid file with its config problem, exit 2, with a name or without', async () => {
    for (const argv of [['check'], ['check', 'production']]) {
      const run = await runMain(argv, { cwd: project('upload: [nope'), env: both });
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain('  ✗ sealup.yml has 1 problem.\n');
    }
  });

  it.each([
    ['a variable not set', productionConfig(), build, {}],
    ['no host key', productionConfig({ hostKey: false }), build, both],
    ['a missing build folder', productionConfig(), {}, both],
    [
      'the manifest folder inside the target',
      `${productionConfig()}    manifest: /home/site/.sealup\n`,
      build,
      both,
    ],
  ])('exits as a deploy would before connecting: %s', async (_, config, files, env) => {
    const cwd = project(config, files);
    // No server: the deploy stops before connecting, or the test fails.
    const deployed = await runMain(['deploy', 'production'], { cwd, env });
    const checked = await runMain(['check', 'production'], { cwd, env });
    expect(deployed.exitCode).not.toBe(0);
    expect(checked.exitCode).toBe(deployed.exitCode);
  });

  it('annotates in GitHub: a warning per other target, the deciding problem as an error', async () => {
    const run = await runMain(['check'], { cwd: project() });
    expect(run.stderr).not.toContain('::');
    const github = await runMain(['check'], { cwd: project(), env: inGitHub });
    expect(github.exitCode).toBe(2);
    const commands = github.stderr.split('\n').filter((line) => /^::(warning|error)/.test(line));
    expect(commands).toEqual([
      '::warning file=sealup.yml,line=14,title=STAGING_KEY not set::Only staging needs it: targets.staging.privateKey.',
      expect.stringMatching(/^::error file=sealup\.yml,line=9,title=PROD_PASSWORD is not set::/),
    ]);
  });

  it('names the variable and its source, never its value', async () => {
    const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' });
    const run = await runMain(['check', '--json'], { cwd: project(config) });
    // runMain fails the test if the canary's value or a form of it is anywhere in the output.
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('Variables set: SEALUP_CANARY_PASSWORD  (from the environment)');
  });

  it('with -q, prints only the warnings and the verdict line', async () => {
    const env = { ...both, NO_COLOR: '1' };
    const run = await runMain(['check', '-q'], { cwd: project(noProductionKey), env, tty: true });
    expect(run.stderr).toBe(
      [
        '  ! No host key saved for production. Run: sealup keyscan production',
        '',
        '  ✓ Ready to deploy to staging. production needs a host key first.',
        '',
      ].join('\n'),
    );
  });

  it('with -q and nothing to warn about, prints the verdict line alone', async () => {
    const env = { ...both, NO_COLOR: '1' };
    const run = await runMain(['check', 'production', '-q'], { cwd: project(), env, tty: true });
    expect(run.stderr).toBe('  ✓ Ready to deploy to production.\n');
    expect(run.exitCode).toBe(0);
  });

  it('gives --json for a target that is not ready: its missing variables and the error', async () => {
    const run = await runMain(['check', 'staging', '--json'], {
      cwd: project(),
      env: { PROD_PASSWORD: 'pw-for-tests' },
    });
    expect(run.exitCode).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({
      format: 1,
      command: 'check',
      target: 'staging',
      status: 'failed',
      exitCode: 2,
      targets: [{ name: 'staging', ready: false, missing: ['STAGING_KEY'] }],
      error: { code: 'variable-not-set', message: 'STAGING_KEY is not set.' },
    });
  });

  it('gives the check object with no target for a check that stops first', async () => {
    const run = await runMain(['check', 'nope', '--json'], { cwd: project(), env: both });
    expect(run.exitCode).toBe(2);
    expect(JSON.parse(run.stdout)).toEqual({
      format: 1,
      version: '0.0.0-source',
      command: 'check',
      target: null,
      status: 'failed',
      exitCode: 2,
      targets: [],
      error: expect.objectContaining({ code: 'unknown-target' }),
    });
  });
});
