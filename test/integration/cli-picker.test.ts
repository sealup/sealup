// main(argv, env, io) (spec #1, seam 2) with the target picker (S12; spec #24 decisions 15-17):
// when it asks, what each option shows, and how the run after a pick ends. The page's own
// screens are in goldens/s12-several-targets.test.ts.

import { describe, expect, it } from 'vitest';
import type { Connect } from '../../src/contracts/index.ts';
import { createMemoryServer, screenOf } from '../../src/testkit/index.ts';
import { createProject, hostKeyLine, productionConfig, ref, runMain } from '../deploy-kit.ts';

const down = '\u001b[B';
const enter = '\r';
const esc = '\u001b';

const env = { PROD_PASSWORD: 'pw-for-tests', STAGING_PASSWORD: 'pw-for-staging' };
const site = { 'public_html/index.html': '<h1>home</h1>' };

/** production (the page's), then staging. */
const twoTargets = [
  productionConfig(),
  '  staging:',
  '    server: sftp://deploy@ssh.example.com/home/staging',
  `    password: ${ref('STAGING_PASSWORD')}`,
  `    hostKey: ${hostKeyLine}`,
  '',
].join('\n');

/** A connect that reaches staging's memory server only. */
function stagingOnly() {
  const server = createMemoryServer();
  const connect: Connect = async (target) => {
    if (target.name !== 'staging') throw new Error(`the run connected to ${target.name}`);
    return server.connect();
  };
  return { server, connect };
}

const options = (config = twoTargets, files: Record<string, string> = site) => ({
  cwd: createProject(config, files).root,
  env,
  tty: true,
  ...stagingOnly(),
});

describe('when the picker asks', () => {
  it('never asks with one target, or with a target named', async () => {
    const one = await runMain(['deploy', '--no-color'], {
      cwd: createProject(productionConfig(), site).root,
      env,
      tty: true,
      server: createMemoryServer(),
    });
    expect(one.exitCode).toBe(0);
    expect(one.stderr).not.toContain('Deploy to which target?');
    const named = await runMain(['deploy', 'staging', '--no-color'], options());
    expect(named.exitCode).toBe(0);
    expect(screenOf(named.stderr)).not.toContain('Next time');
  });

  it('asks on a terminal even when stdout is not one (a pipe): it reads stdin and draws on stderr', async () => {
    // runMain's `tty` sets stdout and stderr together; the picker looks at stdin and stderr.
    const run = await runMain(['deploy', '--no-color', '--json'], {
      ...options(),
      keys: [down, enter],
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ target: 'staging', status: 'ok' });
  });

  it('gives a cancelled pick to --json as status cancelled, exit 130', async () => {
    const run = await runMain(['deploy', '--json'], { ...options(), keys: [esc] });
    expect(run.exitCode).toBe(130);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'cancelled', exitCode: 130 });
  });

  it('stops with no answer, exit 130, when the run is interrupted (SIGTERM) at the picker', async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const run = await runMain(['deploy', '--no-color'], { ...options(), signal: interrupt.signal });
    expect(run.exitCode).toBe(130);
    expect(screenOf(run.stderr)).toContain('  ✗ Stopped: no target was chosen.');
  });
});

describe('the options', () => {
  it('list every target, one that cannot be used included, its server as written', async () => {
    const config = [
      'upload: public_html',
      'targets:',
      '  production:',
      `    server: sftp://${ref('PROD_USER')}@ssh.example.com/home/site`,
      `    password: ${ref('PROD_PASSWORD')}`,
      '  staging:',
      '    server: sftp://deploy@ssh.example.com/home/staging',
      `    password: ${ref('NOT_SET_ANYWHERE')}`,
      '',
    ].join('\n');
    const run = await runMain(['deploy', '--no-color'], {
      cwd: createProject(config, site).root,
      env: { ...env, PROD_USER: 'deploy' },
      tty: true,
      keys: [down, enter],
    });
    const drawn = screenOf(run.stderr.slice(0, run.stderr.indexOf('\u001b[2A')));
    expect(drawn).toBe(
      [
        'Deploy to which target?',
        `  › production   sftp://${ref('PROD_USER')}@ssh.example.com/home/site`,
        '    staging      sftp://deploy@ssh.example.com/home/staging',
        '',
      ].join('\n'),
    );
    // The target picked cannot be used: its config problem stops the run, as when it is named.
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('NOT_SET_ANYWHERE');
  });

  it('show no server whose URL is not valid: a password in the URL is never printed (R3)', async () => {
    const config = [
      'upload: public_html',
      'targets:',
      '  production:',
      '    server: sftp://deploy:Hunter2-in-url@ssh.example.com/home/site',
      `    password: ${ref('PROD_PASSWORD')}`,
      '  staging:',
      '    server: sftp://deploy@ssh.example.com/home/staging',
      `    password: ${ref('STAGING_PASSWORD')}`,
      '',
    ].join('\n');
    const run = await runMain(['deploy', '--no-color'], {
      cwd: createProject(config, site).root,
      env,
      tty: true,
      keys: [esc],
    });
    expect(screenOf(run.stderr.slice(0, run.stderr.indexOf('\u001b[2A')))).toContain(
      '  › production\n    staging      sftp://deploy@ssh.example.com/home/staging\n',
    );
    expect(run.stderr).not.toContain('Hunter2');
  });
});

describe('the run after a pick', () => {
  it('ends with the command that skips the question, with -c as typed', async () => {
    const opts = options();
    const run = await runMain(['deploy', '--no-color', '-c', 'sealup.yml'], {
      ...opts,
      keys: [down, enter],
    });
    expect(run.exitCode).toBe(0);
    expect(screenOf(run.stderr)).toMatch(
      /\n {4}Next time, skip the question: sealup deploy staging -c sealup\.yml\n$/,
    );
  });

  it('keeps the picker under -q, but not the dim line after the result', async () => {
    const run = await runMain(['deploy', '-q', '--no-color'], {
      ...options(),
      keys: [down, enter],
    });
    expect(run.exitCode).toBe(0);
    const screen = screenOf(run.stderr);
    expect(screen).toContain('Deploy to which target?\n  ✓ staging\n');
    expect(screen).toMatch(/✓ Sealed up and delivered: 1 file to staging in [\d.]+ s\.\n$/);
  });

  it('a dry run ends with its own last line, which names the target picked', async () => {
    const run = await runMain(['deploy', '--dry-run', '--no-color'], {
      ...options(),
      keys: [down, enter],
    });
    expect(run.exitCode).toBe(0);
    const screen = screenOf(run.stderr);
    expect(screen).toContain('sealup deploy staging');
    expect(screen).not.toContain('Next time');
  });
});
