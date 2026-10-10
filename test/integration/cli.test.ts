// main(argv, env, io) (spec #1, seam 2): the command line, its exit codes (decision 0023) and
// what it prints, with terminal flags, environment and clock injected. Every run here goes
// through the leak check (runMain).

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryServer, screenOf } from '../../src/testkit/index.ts';
import { createProject, productionConfig, ref, runMain, versionLine } from '../deploy-kit.ts';

const site = { 'public_html/index.html': '<h1>home</h1>' };
const env = { PROD_PASSWORD: 'pw-for-tests' };

function project(config = productionConfig()) {
  return createProject(config, site).root;
}

describe('main: commands and flags', () => {
  it('prints the version for --version', async () => {
    const run = await runMain(['--version'], { cwd: project() });
    expect(run).toEqual({ exitCode: 0, summary: '', stdout: '0.0.0-source\n', stderr: '' });
  });

  it('prints help for -h and --help, listing only what works now (ruling 8)', async () => {
    for (const flag of ['-h', '--help']) {
      const run = await runMain([flag], { cwd: project() });
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('  deploy      Send changes to a target\n');
      expect(run.stdout).toContain('  -c, --config <file>');
      expect(run.stdout).toContain(
        '      --env-file <file>   Read variables from this file (default: sealup.env)\n',
      );
      expect(run.stdout).toContain(
        '      --debug             Show where an unexpected error happened\n',
      );
      // The page's line (reference.js, global flags), now that -q works.
      expect(run.stdout).toContain(
        '  -v, --verbose           Show the file list and timings\n  -q, --quiet             Show the result line only\n',
      );
      expect(run.stdout).toContain(
        "  keyscan     Show the server's host key and save it to sealup.yml\n",
      );
      expect(run.stdout).toContain('  pull        Copy server files (uploads) to this machine\n');
      expect(run.stdout).toContain(
        '  init        Write sealup.yml, sealup.env and a GitHub workflow\n',
      );
      expect(run.stderr).toBe('');
    }
  });

  it.each([
    [['deploy', '--frobnicate'], '✗ Unknown flag --frobnicate.', 'deploy'],
    [['deploy', '-c'], '✗ -c, --config needs a value.', 'deploy'],
    [['deploy', 'production', 'staging'], '✗ deploy takes one target name, not 2.', 'deploy'],
    [['ship'], '✗ Unknown command ship.', undefined],
  ])('refuses %j with exit 2', async (argv, message, command) => {
    const run = await runMain(argv, { cwd: project() });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.split('\n').slice(0, 2)).toEqual([versionLine(command), `  ${message}`]);
    expect(run.stderr).toContain('More: sealup.dev/e/usage');
    expect(run.stdout).toBe('');
  });
});

describe('main: deploy', () => {
  it('deploys the one target of sealup.yml in the current folder, exit 0', async () => {
    const server = createMemoryServer();
    const run = await runMain(['deploy'], { cwd: project(), env, server });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('✓ Sealed up and delivered: 1 file to production in 0.0 s.');
    expect(server.files().has('/home/site/index.html')).toBe(true);
  });

  it('reads the config named by -c, relative to the current folder', async () => {
    const root = createProject('', {
      'site/sealup.yml': productionConfig({ upload: 'public_html' }),
      'site/public_html/index.html': 'x',
    }).root;
    const server = createMemoryServer();
    const run = await runMain(['deploy', '-c', 'site/sealup.yml'], { cwd: root, env, server });
    expect(run.exitCode).toBe(0);
    expect(server.files().has('/home/site/index.html')).toBe(true);
  });

  it('prints config problems with their places, no target block, no value, exit 2', async () => {
    const config = [
      'upload: public_html',
      'parallel: lots',
      'targets:',
      '  production:',
      '    server: sftp://deploy@ssh.example.com/home/site',
      '    password: canary-literal-value',
    ].join('\n');
    const run = await runMain(['deploy'], { cwd: project(config), env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  ✗ sealup.yml has 2 problems.',
        '    parallel (line 2): write a whole number from 1 to 256',
        `    targets.production.password (line 6): holds a password; use ${ref('NAME')}`,
        '',
        '    sealup did not connect. Nothing was changed.',
        '    More: sealup.dev/e/config-invalid',
        '',
      ].join('\n'),
    );
    expect(run.stderr).not.toContain('canary-literal-value');
  });

  it('finds sealup.yml in a parent folder, up to the repo root', async () => {
    const root = createProject(productionConfig(), {
      ...site,
      '.git/HEAD': '',
      'src/app/x': '',
    }).root;
    const server = createMemoryServer();
    const run = await runMain(['deploy'], { cwd: join(root, 'src', 'app'), env, server });
    expect(run.exitCode).toBe(0);
    expect(server.files().has('/home/site/index.html')).toBe(true);
  });

  it('says where it looked when there is no sealup.yml, exit 2', async () => {
    const root = createProject('', { 'repo/.git': '', 'repo/src/x': '' }).root;
    const run = await runMain(['deploy'], { cwd: join(root, 'repo', 'src') });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  ✗ There is no sealup.yml here.',
        `    sealup looked in ${join(root, 'repo', 'src')}`,
        `    and each folder above it up to the repo root, ${join(root, 'repo')}`,
        '    Run sealup in the folder that holds sealup.yml, or point to it with -c <file>.',
        '',
        '    Nothing was changed.',
        '    More: sealup.dev/e/config-not-found',
        '',
      ].join('\n'),
    );
  });

  it('refuses a folder with both sealup.yml and sealup.yaml, exit 2', async () => {
    const root = createProject(productionConfig(), { ...site, 'sealup.yaml': '' }).root;
    const run = await runMain(['deploy'], { cwd: root, env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        `  ✗ Two config files in ${root}: sealup.yml and sealup.yaml.`,
        '    sealup will not guess which one counts. Keep one of them.',
        '',
        '    Nothing was changed.',
        '    More: sealup.dev/e/config-ambiguous',
        '',
      ].join('\n'),
    );
  });

  it('says when the file named by -c is missing, exit 2', async () => {
    const root = createProject('', {}).root;
    const run = await runMain(['deploy', '-c', 'other.yml'], { cwd: root });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.split('\n').slice(0, 3)).toEqual([
      versionLine('deploy'),
      '  ✗ There is no other.yml here.',
      `    sealup looked for ${join(root, 'other.yml')}`,
    ]);
    expect(run.stderr).toContain('More: sealup.dev/e/config-not-found');
  });
});

describe('main: choosing the target (reference scenarios S12, S13)', () => {
  const twoTargets = [
    'upload: public_html',
    'targets:',
    ...['production', 'staging'].flatMap((name) => [
      `  ${name}:`,
      '    server: sftp://deploy@ssh.example.com:22/home/site',
      `    password: ${ref('PROD_PASSWORD')}`,
    ]),
  ].join('\n');

  it('S13: an unknown name stops with exit 2, a did-you-mean and the list', async () => {
    const run = await runMain(['deploy', 'prod'], { cwd: project(twoTargets), env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy', 'prod'),
        '  ✗ No target named prod in sealup.yml.',
        '    Did you mean production?  sealup deploy production',
        '    Targets in sealup.yml: production, staging.',
        '',
        '    Nothing was changed.',
        '    More: sealup.dev/e/unknown-target',
        '',
      ].join('\n'),
    );
  });

  it('S13: a typo is close enough; a name far from every target gets no guess', async () => {
    const typo = await runMain(['deploy', 'stagnig'], { cwd: project(twoTargets), env });
    expect(typo.stderr).toContain('    Did you mean staging?  sealup deploy staging\n');
    const far = await runMain(['deploy', 'qa'], { cwd: project(twoTargets), env });
    expect(far.stderr).not.toContain('Did you mean');
  });

  it('S12: several targets and none named stops with exit 2, listing them', async () => {
    const run = await runMain(['deploy'], { cwd: project(twoTargets), env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  ✗ Which target? sealup.yml has 2 and none was named.',
        '    sealup asks only on a terminal. Name the target in the command:',
        '      sealup deploy production',
        '      sealup deploy staging',
        '',
        '    Nothing was changed.',
        '    More: sealup.dev/e/target-not-named',
        '',
      ].join('\n'),
    );
  });

  it('deploys one target although another target has config problems', async () => {
    const config = [
      productionConfig(),
      '  staging:',
      '    server: sftp://deploy@ssh.example.com/home/site',
      `    password: ${ref('STAGING_PASSWORD')}`,
      '    url: not-a-site',
    ].join('\n');
    const server = createMemoryServer();
    const run = await runMain(['deploy', 'production'], { cwd: project(config), env, server });
    expect(run.exitCode).toBe(0);
    const staging = await runMain(['deploy', 'staging'], { cwd: project(config), env });
    expect(staging.exitCode).toBe(2);
    expect(staging.stderr).toBe(
      [
        versionLine('deploy', 'staging'),
        '  ✗ sealup.yml has 2 problems.',
        `    targets.staging.password (line 11): reads ${ref('STAGING_PASSWORD')}, which is not set`,
        '    targets.staging.url (line 12): write https://… or http://…',
        '',
        '    sealup did not connect. Nothing was changed on staging.',
        '    More: sealup.dev/e/config-invalid',
        '',
      ].join('\n'),
    );
  });
});

describe('main: variables and secrets (reference scenarios S14, S15)', () => {
  it('S14: an unset variable stops with exit 2, naming it and its place', async () => {
    const run = await runMain(['deploy', 'production'], { cwd: project(), env: {} });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy', 'production'),
        '  ✗ PROD_PASSWORD is not set.',
        `    targets.production.password (sealup.yml line 5) reads ${ref('PROD_PASSWORD')}.`,
        '    sealup looked in the environment and in sealup.env.',
        '    Add this line to sealup.env, next to sealup.yml:  PROD_PASSWORD=…',
        '',
        '    sealup did not connect. Nothing was changed on production.',
        '    More: sealup.dev/e/variable-not-set',
        '',
      ].join('\n'),
    );
  });

  it(`S14: $\{VAR:?message} prints the config's own message as the fix`, async () => {
    const config = productionConfig({ password: 'PROD_PASSWORD:?ask the team for the password' });
    const run = await runMain(['deploy'], { cwd: project(config), env: {} });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.split('\n').slice(0, 5)).toEqual([
      versionLine('deploy'),
      '  ✗ PROD_PASSWORD is not set.',
      `    targets.production.password (sealup.yml line 5) reads ${ref('PROD_PASSWORD')}.`,
      '    sealup looked in the environment and in sealup.env.',
      '    ask the team for the password',
    ]);
  });

  it('reads the password from sealup.env next to sealup.yml', async () => {
    const root = createProject(productionConfig(), {
      ...site,
      'sealup.env': 'PROD_PASSWORD=pw-from-file\n',
    }).root;
    const server = createMemoryServer();
    const run = await runMain(['deploy'], { cwd: root, env: {}, server });
    expect(run.exitCode).toBe(0);
  });

  it('reads --env-file, relative to the current folder, instead of sealup.env', async () => {
    const root = createProject(productionConfig(), {
      ...site,
      'secrets/prod.env': 'PROD_PASSWORD=pw-from-file\n',
    }).root;
    const server = createMemoryServer();
    const run = await runMain(['deploy', '--env-file', 'secrets/prod.env'], {
      cwd: root,
      env: {},
      server,
    });
    expect(run.exitCode).toBe(0);
    const missing = await runMain(['deploy', '--env-file', 'nope.env'], { cwd: root, env: {} });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toBe(
      [
        versionLine('deploy'),
        `  ✗ There is no env file at ${join(root, 'nope.env')}.`,
        '    Check the path given to --env-file.',
        '',
        '    Nothing was changed.',
        '    More: sealup.dev/e/env-file-not-found',
        '',
      ].join('\n'),
    );
  });

  it('names the --env-file in S14 when it was given', async () => {
    const root = createProject(productionConfig(), { ...site, 'prod.env': '' }).root;
    const run = await runMain(['deploy', '--env-file', 'prod.env'], { cwd: root, env: {} });
    expect(run.stderr.split('\n').slice(3, 5)).toEqual([
      `    sealup looked in the environment and in ${join(root, 'prod.env')}.`,
      `    Add this line to ${join(root, 'prod.env')}:  PROD_PASSWORD=…`,
    ]);
  });

  it('S15: a password written in the config stops with exit 2 and the three steps', async () => {
    const config = productionConfig().replace(ref('PROD_PASSWORD'), 'canary-literal-value');
    const run = await runMain(['deploy'], { cwd: project(config), env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  ✗ sealup.yml holds a password: targets.production.password (line 5).',
        '    sealup takes passwords only from variables, so they stay out of git.',
        '    1. Move the value to sealup.env (git-ignored):  PRODUCTION_PASSWORD=…',
        `    2. Write this on line 5 instead:                password: ${ref('PRODUCTION_PASSWORD')}`,
        '    3. If sealup.yml was ever committed, the password is in your git history:',
        '       change it with your host.',
        '',
        '    sealup did not connect. Nothing was changed on production.',
        '    More: sealup.dev/e/secret-in-config',
        '',
      ].join('\n'),
    );
    expect(run.stderr).not.toContain('canary-literal-value');
  });

  it('R2: a password under 6 characters stops with exit 2, naming the variable and the rule', async () => {
    const root = project();
    const short = { PROD_PASSWORD: 'abc12' };
    const run = await runMain(['deploy'], { cwd: root, env: short });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  ✗ sealup.yml has 1 problem.',
        `    targets.production.password (line 5): ${ref('PROD_PASSWORD')} is under 6 characters`,
        '',
        '    sealup did not connect. Nothing was changed on production.',
        '    More: sealup.dev/e/config-invalid',
        '',
      ].join('\n'),
    );
    const json = await runMain(['deploy', '--json'], { cwd: root, env: short });
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      status: 'failed',
      exitCode: 2,
      error: {
        code: 'config-invalid',
        message: 'sealup.yml has 1 problem.',
        fix: `targets.production.password (line 5): ${ref('PROD_PASSWORD')} is under 6 characters`,
      },
    });
    for (const output of [run.stderr, json.stdout, json.stderr]) {
      expect(output).not.toContain('abc12');
    }
    const enough = await runMain(['deploy'], {
      cwd: root,
      env: { PROD_PASSWORD: 'abc123' },
      server: createMemoryServer(),
    });
    expect(enough.exitCode).toBe(0);
  });

  it('R4: a password with a line break or an edge space is worded as before', async () => {
    const run = await runMain(['deploy'], { cwd: project(), env: { PROD_PASSWORD: ' pw-edge' } });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.split('\n')[2]).toBe(
      `    targets.production.password (line 5): ${ref('PROD_PASSWORD')} has a line break, NUL or edge space`,
    );
  });
});

describe('main: colour (ruling 5)', () => {
  const ansi = '\u001b[';
  it.each([
    ['NO_COLOR is set', { NO_COLOR: '1' }, []],
    ['--no-color is given', {}, ['--no-color']],
  ])('is off on a terminal when %s', async (_, extraEnv, flags) => {
    const run = await runMain(['deploy', ...flags], {
      cwd: project(),
      env: { ...env, ...extraEnv },
      tty: true,
      server: createMemoryServer(),
    });
    expect(run.exitCode).toBe(0);
    // The progress line's erase is cursor control, not colour; once the screen is drawn, no
    // escape code is left.
    expect(screenOf(run.stderr)).not.toContain(ansi);
  });

  it('is on for a terminal, whatever FORCE_COLOR says, and off when not one', async () => {
    const on = await runMain(['deploy'], {
      cwd: project(),
      env: { ...env, FORCE_COLOR: '0' },
      tty: true,
      server: createMemoryServer(),
    });
    expect(on.stderr).toContain(ansi);
    const off = await runMain(['deploy'], {
      cwd: project(),
      env: { ...env, FORCE_COLOR: '1' },
      server: createMemoryServer(),
    });
    expect(off.stderr).not.toContain(ansi);
  });
});
