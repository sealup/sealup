// The full mirror through main() (decision 0030, spec #41 decision 29, seam 1): `--mirror` on
// `deploy`, or `mirror: true` on a mapping, deletes what the server folder holds that is not in
// the build, after every upload has arrived, a first deploy too; never an excluded path, the
// manifest or the lock; a server link stops the run, or is left alone with `allow: [symlinks]`.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ServerPath } from '../../src/contracts/index.ts';
import { createMemoryServer } from '../../src/testkit/index.ts';
import {
  createProject,
  hostKeyLine,
  inGitHub,
  productionConfig,
  ref,
  runMain,
  siteFiles,
} from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

/** A project and a server whose target folder already holds files sealup never uploaded. */
function strayServer(
  build: Record<string, string> = { 'public_html/index.html': '<h1>v1</h1>' },
  config = productionConfig(),
) {
  const project = createProject(config, build);
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  server.seedFile('/home/site/old.php', 'old');
  server.seedFile('/home/site/old/a/b.txt', 'old');
  const run = (argv: readonly string[], options: { env?: Record<string, string> } = {}) =>
    runMain(argv, { cwd: project.root, env: { ...env, ...options.env }, server });
  const remove = (path: string) => rmSync(join(project.root, ...path.split('/')));
  return { server, run, remove };
}

describe('sealup deploy --mirror', () => {
  it('deletes the files and folders not in the build, on a first deploy too', async () => {
    const site = strayServer();

    const run = await site.run(['deploy', '--mirror']);

    expect(run.exitCode).toBe(0);
    expect(siteFiles(site.server)).toEqual(['index.html']);
    expect(site.server.folders().filter((folder) => folder.startsWith('/home/site/'))).toEqual([]);
  });

  it('lists every delete in the dry run with its reason, and changes nothing', async () => {
    const site = strayServer();

    const run = await site.run(['deploy', '-n', '--mirror', '--json']);

    expect(run.exitCode).toBe(0);
    const lines = run.stderr.split('\n');
    expect(lines).toContain('  First deploy: files not in your build are deleted (mirror).');
    expect(lines).toContain('  Would delete 2 files  (mirror: sealup did not upload them)');
    expect(lines).toContain('    - old.php  not in the build');
    expect(lines).toContain('    - old/a/b.txt  not in the build');
    expect(run.stderr).toContain('To apply: sealup deploy production --mirror');
    expect(JSON.parse(run.stdout).ops).toEqual([
      { op: 'upload', path: 'index.html', reason: 'new', size: 11 },
      { op: 'delete', path: 'old.php', reason: 'not-in-build', size: null },
      { op: 'delete', path: 'old/a/b.txt', reason: 'not-in-build', size: null },
    ]);
    expect(siteFiles(site.server)).toEqual(['old.php', 'old/a/b.txt']);
  });

  it('keeps both reasons apart: left the build, not in the build (-v, job summary)', async () => {
    const site = strayServer({
      'public_html/index.html': '<h1>v1</h1>',
      'public_html/gone.js': 'v1',
    });
    expect((await site.run(['deploy'])).exitCode).toBe(0);
    site.remove('public_html/gone.js');

    const run = await site.run(['deploy', '-v', '--mirror'], { env: inGitHub });

    expect(run.exitCode).toBe(0);
    const plain = stripVTControlCharacters(run.stderr).split('\n');
    expect(plain).toContain('    - gone.js');
    expect(plain).toContain('    - old.php  not in the build');
    expect(run.summary).toContain('- gone.js\n');
    expect(run.summary).toContain('- old.php  not in the build');
    expect(siteFiles(site.server)).toEqual(['index.html']);
  });

  it('deletes nothing when an upload fails: deletes come after every upload (0023 §5)', async () => {
    const site = strayServer({ 'public_html/a.html': 'a', 'public_html/b.html': 'b' });
    // The first put is the lock's note (decision 0031), then the two uploads.
    site.server.faults.failWrite(3, 'quota');

    const run = await site.run(['deploy', '--mirror']);

    expect(run.exitCode).toBe(1);
    // a.html arrived, b.html did not: nothing of the server's own was deleted.
    expect(siteFiles(site.server)).toEqual(['a.html', 'old.php', 'old/a/b.txt']);
  });

  it('never deletes excluded paths, files written from a secret, the manifest or the lock', async () => {
    const config = [
      'upload: public_html',
      'exclude:',
      '  - public_html/uploads',
      '  - "*.log"',
      'targets:',
      '  production:',
      '    server: sftp://deploy@ssh.example.com:22/home/site',
      `    password: ${ref('PROD_PASSWORD')}`,
      `    hostKey: ${hostKeyLine}`,
      '    write:',
      `      .env: ${ref('APP_ENV')}`,
      '',
    ].join('\n');
    const site = strayServer({ 'public_html/index.html': '<h1>v1</h1>' }, config);
    site.server.seedFile('/home/site/uploads/2024/cat.jpg', 'a cat');
    site.server.seedFile('/home/site/logs/error.log', 'oops');
    site.server.seedFile('/home/deploy/.sealup/unrelated.json', '{}');

    const run = await site.run(['deploy', '--mirror'], { env: { APP_ENV: 'APP_KEY=x' } });

    expect(run.exitCode).toBe(0);
    expect(siteFiles(site.server)).toEqual([
      '.env',
      'index.html',
      'logs/error.log',
      'uploads/2024/cat.jpg',
    ]);
    const kept = [...site.server.files().keys()].filter((path) => path.startsWith('/home/deploy/'));
    expect(kept).toContain('/home/deploy/.sealup/unrelated.json');
    expect(
      kept.some((path) => path.endsWith('.json') && path !== '/home/deploy/.sealup/unrelated.json'),
    ).toBe(true);
  });

  it('deletes a pull: folder that no exclude covers, as 0008 says (ruling 2)', async () => {
    const config = productionConfig({ upload: 'public_html' }).replace(
      'targets:',
      'pull:\n  resources: public_html/resources\ntargets:',
    );
    const site = strayServer({ 'public_html/index.html': '<h1>v1</h1>' }, config);
    site.server.seedFile('/home/site/resources/avatar.png', 'a user upload');

    const run = await site.run(['deploy', '--mirror']);

    expect(run.exitCode).toBe(0);
    expect(siteFiles(site.server)).toEqual(['index.html']);
  });

  it('leaves alone what is neither file, folder nor link, and its folder', async () => {
    const site = strayServer();
    site.server.seedOther('/home/site/run/php.sock');

    const run = await site.run(['deploy', '--mirror']);

    expect(run.exitCode).toBe(0);
    expect(site.server.folders()).toContain('/home/site/run');
    expect(siteFiles(site.server)).toEqual(['index.html']);
  });

  it('mirrors only the mapping that says mirror: true', async () => {
    const config = productionConfig({
      upload: '\n  public_html:\n    to: www\n    mirror: true\n  api: api',
    });
    const site = strayServer(
      { 'public_html/index.html': '<h1>v1</h1>', 'api/index.php': '<?php' },
      config,
    );
    site.server.seedFile('/home/site/www/stray.js', 'x');
    site.server.seedFile('/home/site/api/stray.php', 'x');

    const run = await site.run(['deploy']);

    expect(run.exitCode).toBe(0);
    expect(siteFiles(site.server)).toEqual([
      'api/index.php',
      'api/stray.php',
      'old.php',
      'old/a/b.txt',
      'www/index.html',
    ]);
  });

  it.each(['pull', 'check', 'keyscan'])(
    'is refused by %s (exit 2), never ignored',
    async (command) => {
      const site = strayServer();

      const run = await site.run([command, '--mirror']);

      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(`${command} does not take --mirror.`);
    },
  );
});

describe('sealup check and pull: folders under a mirrored mapping (ruling 2)', () => {
  const pulling = (exclude: string[] = []) =>
    [
      'upload:',
      '  public_html:',
      '    to: www',
      '    mirror: true',
      ...(exclude.length === 0 ? [] : ['exclude:', ...exclude.map((pattern) => `  - ${pattern}`)]),
      'pull:',
      '  www/resources: public_html/resources',
      '  backup: backup',
      ...productionConfig().split('\n').slice(1),
    ].join('\n');

  it('prints a yellow line for a pull: folder no exclude covers, and a GitHub warning', async () => {
    const project = createProject(pulling(), { 'public_html/index.html': 'x' });

    const run = await runMain(['check'], { cwd: project.root, env: { ...env, ...inGitHub } });

    expect(run.exitCode).toBe(0);
    const lines = stripVTControlCharacters(run.stderr).split('\n');
    expect(lines).toContain(
      '  ! The mirror deletes the pull: folder www/resources: no exclude covers it.',
    );
    expect(lines).toContain('    To keep it, add public_html/resources to exclude in sealup.yml.');
    expect(run.stderr).toContain(
      '::warning file=sealup.yml,line=6,title=Pull folder not excluded::The mirror deletes the pull: folder www/resources. To keep it, exclude public_html/resources.',
    );
    expect(run.stderr).not.toContain('backup');
  });

  it('says nothing once an exclude covers it', async () => {
    const project = createProject(pulling(['public_html/resources']), {
      'public_html/index.html': 'x',
    });

    const run = await runMain(['check'], { cwd: project.root, env, tty: true });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain('pull: folder');
  });
});

describe('the full mirror and server links (R16, spec #41 decisions 27-28)', () => {
  const allowing = `${productionConfig()}    allow: [symlinks]\n`;

  it('stops on a link it lists, exit 6, before any change, a dry run too', async () => {
    const site = strayServer();
    site.server.seedLink('/home/site/old/storage', '/home/deploy/storage');

    for (const argv of [
      ['deploy', '-n', '--mirror'],
      ['deploy', '--mirror'],
    ]) {
      const run = await site.run(argv);

      expect(run.exitCode).toBe(6);
      expect(run.stderr).toContain('/home/site/old/storage is a symlink on the server');
    }
    expect(siteFiles(site.server)).toEqual(['old.php', 'old/a/b.txt']);
  });

  it('leaves the link alone with allow: [symlinks], and says so in the dry run', async () => {
    const site = strayServer(undefined, allowing);
    site.server.seedLink('/home/site/old/storage', '/home/deploy/storage');
    site.server.seedFile('/home/deploy/storage/avatar.png', 'behind the link');

    const dry = await site.run(['deploy', '-n', '--mirror']);
    expect(dry.stderr.split('\n')).toContain(
      '    · old/storage  a link on the server, never deleted',
    );
    const run = await site.run(['deploy', '--mirror']);

    expect(run.exitCode).toBe(0);
    expect(siteFiles(site.server)).toEqual(['index.html']);
    const session = await site.server.connect();
    expect((await session.stat('/home/site/old/storage' as ServerPath)).kind).toBe('link');
    expect(site.server.files().has('/home/deploy/storage/avatar.png')).toBe(true);
  });

  it('treats a mirrored folder that is a link as a link found there', async () => {
    const config = productionConfig({ upload: '\n  public_html:\n    to: www\n    mirror: true' });
    const site = strayServer({ 'public_html/index.html': '<h1>v1</h1>' }, config);
    site.server.seedLink('/home/site/www', '/home/deploy/elsewhere');
    site.server.seedFile('/home/deploy/elsewhere/keep.txt', 'not the build');

    const run = await site.run(['deploy']);

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain('/home/site/www is a symlink on the server');
    expect(site.server.files().has('/home/deploy/elsewhere/keep.txt')).toBe(true);
  });
});

describe('the full mirror and R21 listing caps', () => {
  it('stops past 64 levels before any change: exit 6, its own words and page', async () => {
    const site = strayServer();
    site.server.seedFile(`/home/site/${Array(65).fill('d').join('/')}/deep.txt`, 'x');

    const run = await site.run(['deploy', '--mirror']);

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain('folders deep: sealup stopped listing.');
    expect(run.stderr).toContain('or deploy without the mirror: drop --mirror, or mirror: true.');
    expect(run.stderr).toContain('More: sealup.dev/e/listing-too-large');
    expect(siteFiles(site.server)).toContain('old.php');
  });
});
