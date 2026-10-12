// main(argv, env, io) (spec #1, seam 2): `--json` prints one JSON object on stdout, for every
// way a run ends, while the human output stays on stderr (spec story 54, "--json object"). The
// successful runs are in the S07-S10 goldens; these are the others. Every run goes through the
// leak check, the JSON object included.

import { describe, expect, it } from 'vitest';
import { createMemoryServer } from '../../src/testkit/index.ts';
import { createProject, productionConfig, runMain } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const site = { 'public_html/index.html': '<h1>home</h1>' };
const noTime = { connect: 0, scan: 0, compare: 0, transfer: 0 };
const nothingDone = { uploaded: 0, written: 0, deleted: 0, unchanged: 0, bytes: 0 };
const production = {
  target: 'production',
  server: 'sftp://deploy@ssh.example.com:22/home/site',
  url: 'https://example.com',
};

function json(stdout: string): unknown {
  expect(stdout.endsWith('}\n')).toBe(true);
  expect(stdout.split('\n')).toHaveLength(2);
  return JSON.parse(stdout);
}

// Decision 0026 point 4: the order of the keys a version already printed is frozen; a key added
// later (lane C's `written`) comes after all of them, whatever the run.
const keysBeforeLaneC = [
  'format',
  'version',
  'command',
  'target',
  'server',
  'url',
  'dryRun',
  'status',
  'exitCode',
  'uploaded',
  'deleted',
  'unchanged',
  'bytes',
  'durationMs',
  'timings',
  'ops',
  'failed',
  'error',
];

describe('--json: the order of the keys', () => {
  it.each([
    ['a deploy', ['deploy']],
    ['a dry run', ['deploy', '--dry-run']],
    ['an error', ['deploy', 'nope']],
  ])('keeps the keys of before in their order, then written (%s)', async (_, argv) => {
    const root = createProject(productionConfig(), site).root;
    const run = await runMain([...argv, '--json'], {
      cwd: root,
      env,
      server: createMemoryServer({ loginFolder: '/home/deploy' }),
    });
    const keys = Object.keys(json(run.stdout) as object);
    expect(keys.at(-1)).toBe('written');
    const before = keys.slice(0, -1);
    expect(before).toEqual(keysBeforeLaneC.filter((key) => before.includes(key)));
  });
});

describe('--json', () => {
  it('reports a usage error before any target, with the error in words', async () => {
    const root = createProject(productionConfig(), site).root;
    const run = await runMain(['deploy', '--json', '--frobnicate'], { cwd: root, env });

    expect(run.exitCode).toBe(2);
    expect(json(run.stdout)).toEqual({
      format: 1,
      version: '0.0.0-source',
      command: 'deploy',
      target: null,
      server: null,
      url: null,
      dryRun: false,
      status: 'failed',
      exitCode: 2,
      ...nothingDone,
      durationMs: 0,
      timings: noTime,
      error: {
        code: 'usage',
        message: 'Unknown flag --frobnicate.',
        fix: 'Run sealup --help for the commands and flags that work.',
        state: 'Nothing was changed.',
      },
    });
    expect(run.stderr).toContain('  ✗ Unknown flag --frobnicate.\n');
  });

  it('reports a stop on the server identity with the target, exit 4', async () => {
    const root = createProject(productionConfig({ hostKey: false }), site).root;
    const run = await runMain(['deploy', '--dry-run', '--json'], { cwd: root, env });

    expect(run.exitCode).toBe(4);
    expect(json(run.stdout)).toMatchObject({
      ...production,
      dryRun: true,
      status: 'failed',
      exitCode: 4,
      error: {
        code: 'host-key-missing',
        message: 'sealup cannot confirm this server is yours: there is no host key.',
        state: 'sealup did not connect. Nothing was changed on production.',
      },
    });
    expect(json(run.stdout)).not.toHaveProperty('ops');
    expect((json(run.stdout) as { error: { fix: string } }).error.fix).toContain(
      'Run on your machine:  sealup keyscan production\n',
    );
  });

  it('reports a run that stopped part-way: what arrived, what failed, exit 1', async () => {
    const root = createProject(productionConfig(), {
      'public_html/a.html': 'aaaa',
      'public_html/b.html': 'bbbb',
      'public_html/c.html': 'cccc',
    }).root;
    const server = createMemoryServer();
    // The second upload: the lock's note (decision 0031) is the first put.
    server.faults.failWrite(3, 'quota');
    const run = await runMain(['deploy', '--json'], { cwd: root, env, server });

    expect(run.exitCode).toBe(1);
    expect(json(run.stdout)).toMatchObject({
      ...production,
      dryRun: false,
      status: 'partial',
      exitCode: 1,
      uploaded: 2,
      bytes: 8,
      failed: [{ path: 'b.html', code: 'quota' }],
      error: { code: 'quota-full' },
    });
  });

  it('lists no operation on a dry run with nothing to do', async () => {
    const root = createProject(productionConfig(), site).root;
    const server = createMemoryServer();
    await runMain(['deploy'], { cwd: root, env, server });
    const run = await runMain(['deploy', '--dry-run', '--json'], { cwd: root, env, server });

    expect(json(run.stdout)).toMatchObject({
      dryRun: true,
      status: 'unchanged',
      exitCode: 0,
      unchanged: 1,
      ops: [],
    });
  });

  it('never prints the JSON object for --help and --version: they print their text', async () => {
    const root = createProject(productionConfig(), site).root;
    const run = await runMain(['--version', '--json'], { cwd: root, env });
    expect(run.stdout).toBe('0.0.0-source\n');
  });
});
