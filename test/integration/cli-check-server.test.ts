// `sealup deploy --check-server` through main() (spec #41 decision 26, seam 1): the flag turns the
// server check on for one run; each file it puts back is "changed on the server" in the dry run,
// the `-v` list, the job summary and `--json`; a listing past R21's caps stops with exit 6. Other
// commands refuse the flag, never ignore it.

import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createMemoryServer } from '../../src/testkit/index.ts';
import { createProject, inGitHub, productionConfig, runMain } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

/** A site deployed once through main(); then robots.txt is edited by hand on the server. */
async function handEdited(files: Record<string, string> = {}) {
  const project = createProject(productionConfig(), {
    'public_html/index.html': '<h1>v1</h1>',
    'public_html/robots.txt': 'User-agent: *',
    ...files,
  });
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  const first = await runMain(['deploy'], { cwd: project.root, env, server });
  expect(first.exitCode).toBe(0);
  server.seedFile('/home/site/robots.txt', 'User-agent: *\nDisallow: /');
  const run = (argv: readonly string[], options: { env?: Record<string, string> } = {}) =>
    runMain(argv, { cwd: project.root, env: { ...env, ...options.env }, server });
  return { server, run };
}

const robots = (server: ReturnType<typeof createMemoryServer>): string =>
  new TextDecoder().decode(server.files().get('/home/site/robots.txt')?.bytes);

describe('sealup deploy --check-server', () => {
  it('lists the hand-edited file in the dry run as changed on the server', async () => {
    const site = await handEdited();

    const run = await site.run(['deploy', '-n', '--check-server', '--json']);

    expect(run.exitCode).toBe(0);
    const lines = run.stderr.split('\n');
    // Sizes end at column 72, as in S10.
    expect(lines).toContain(`  Would upload 1 file${' '.repeat(47)}13 B`);
    expect(lines).toContain(`    ~ robots.txt  changed on the server${' '.repeat(29)}13 B`);
    expect(run.stderr).toContain('To apply: sealup deploy production --check-server');
    expect(JSON.parse(run.stdout).ops).toEqual([
      { op: 'upload', path: 'robots.txt', reason: 'changed-on-server', size: 13 },
    ]);
    expect(robots(site.server)).toBe('User-agent: *\nDisallow: /');
  });

  it('puts the file back, says so under -v and in the job summary', async () => {
    const site = await handEdited();

    const run = await site.run(['deploy', '-v', '--check-server'], { env: inGitHub });

    expect(run.exitCode).toBe(0);
    expect(stripVTControlCharacters(run.stderr)).toContain(
      '    ~ robots.txt  changed on the server',
    );
    expect(run.summary).toContain('~ robots.txt  changed on the server');
    expect(robots(site.server)).toBe('User-agent: *');
  });

  it('is off without the flag', async () => {
    const site = await handEdited();

    const run = await site.run(['deploy']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('Already up to date');
    expect(robots(site.server)).toBe('User-agent: *\nDisallow: /');
  });

  it('stops before any change on a folder past 64 levels (R21): exit 6, its own page', async () => {
    const deep = `public_html/${Array(65).fill('d').join('/')}/deep.txt`;
    const site = await handEdited({ [deep]: 'x' });

    const run = await site.run(['deploy', '--check-server']);

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain('folders deep: sealup stopped listing.');
    expect(run.stderr).toContain('--check-server, or checkServer: true in sealup.yml.');
    expect(run.stderr).toContain('Nothing was changed on production.');
    expect(run.stderr).toContain('More: sealup.dev/e/listing-too-large');
    expect(robots(site.server)).toBe('User-agent: *\nDisallow: /');
  });

  it.each(['pull', 'check', 'keyscan'])(
    'is refused by %s (exit 2), never ignored',
    async (command) => {
      const site = await handEdited();

      const run = await site.run([command, '--check-server']);

      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(`${command} does not take --check-server.`);
    },
  );

  it('is in help deploy', async () => {
    const site = await handEdited();

    const run = await site.run(['help', 'deploy']);

    expect(run.stdout + run.stderr).toContain('--check-server');
  });
});
