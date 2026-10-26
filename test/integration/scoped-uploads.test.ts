import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryServer } from '../../src/testkit/index.ts';
import { createProject, hostKeyLine, ref, runMain } from '../deploy-kit.ts';

describe('scoped uploads through a deploy', () => {
  it.each([
    '  api: [api]\n  api.0: api/app.php',
    '  api.0: api/app.php\n  api: [api]',
    '  api: [api]\n  api.0: [api/app.php]',
  ])('refuses overlapping entries whose displayed locations alias: %s', async (uploads) => {
    const project = createProject(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('PROD_PASSWORD')}`,
        `hostKey: ${hostKeyLine}`,
        'upload:',
        uploads,
      ].join('\n'),
      { 'api/app.php': 'original', 'api.0': 'replacement' },
    );
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const result = await runMain(['deploy', '-c', project.config, '--dry-run', '--json'], {
      cwd: project.root,
      server,
      env: { PROD_PASSWORD: 'pw-for-tests' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('same-server-path');
    expect(server.logins()).toEqual([]);
  });
  it('still refuses two array destinations that send the same server file before connecting', async () => {
    const project = createProject(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('PROD_PASSWORD')}`,
        `hostKey: ${hostKeyLine}`,
        'upload:',
        '  api: [api, api]',
      ].join('\n'),
      { 'api/app.php': '<?php' },
    );
    const result = await runMain(['deploy', '-c', project.config, '--json'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('same-server-path');
  });
  it.each([false, true])('keeps excluded runtime data during prune (mirror=%s)', async (mirror) => {
    const config = (exclude: boolean) =>
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('PROD_PASSWORD')}`,
        `hostKey: ${hostKeyLine}`,
        'upload:',
        '  api:',
        '    to: api',
        ...(exclude ? ['    exclude: [.env*, storage/]'] : []),
        ...(exclude ? ['  api/.env.prod: api/.env'] : []),
      ].join('\n');
    const project = createProject(config(false), {
      'api/app.php': '<?php',
      'api/storage/session': 'recorded runtime',
      'api/.env.prod': 'APP_ENV=production',
      'api/.env.other': 'APP_ENV=other',
    });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const options = { cwd: project.root, server, env: { PROD_PASSWORD: 'pw-for-tests' } };
    expect((await runMain(['deploy', '-c', project.config], options)).exitCode).toBe(0);
    server.seedFile('/home/site/api/storage/unrecorded', 'server runtime');
    writeFileSync(project.config, config(true));
    writeFileSync(join(project.root, 'api/.env.prod'), 'APP_ENV=current');
    const args = ['deploy', '-c', project.config, ...(mirror ? ['--mirror'] : [])];
    expect((await runMain(args, options)).exitCode).toBe(0);
    expect(server.files().get('/home/site/api/.env')?.sha256).toBe(
      createHash('sha256').update('APP_ENV=current').digest('hex'),
    );
    expect(server.files().has('/home/site/api/storage/session')).toBe(true);
    expect(server.files().has('/home/site/api/storage/unrecorded')).toBe(true);
    expect(server.files().has('/home/site/api/.env.prod')).toBe(true);
    // A fresh server proves source filenames are never sent under the new config.
    const fresh = createMemoryServer({ loginFolder: '/home/deploy' });
    expect((await runMain(args, { ...options, server: fresh })).exitCode).toBe(0);
    expect(fresh.files().has('/home/site/api/.env.prod')).toBe(false);
    expect(fresh.files().has('/home/site/api/.env.other')).toBe(false);
  });
});
