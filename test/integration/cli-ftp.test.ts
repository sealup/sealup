// `ftp://` beyond the S23 golden (spec #41 decisions 4, 10-12; plan 05 T03), through main() with
// the in-process FTP server: keyscan has no key to trust, check needs no host key, pull reads an
// FTP server, `parallel` counts connections.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canaries, createFtpServer, type FtpServer, screenOf } from '../../src/testkit/index.ts';
import { createProject, inGitHub, newProject, ref, runMain, versionLine } from '../deploy-kit.ts';
import { dialing } from '../sftp-kit.ts';

const servers: FtpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function ftpServer(
  options: { readonly siteChmod?: boolean; readonly maxConnections?: number } = {},
): Promise<FtpServer> {
  const server = await createFtpServer({ password: canaries.SEALUP_CANARY_PASSWORD, ...options });
  servers.push(server);
  return server;
}

/** The S23 target: `ftp://`, no hostKey, the server on line 4. */
const ftpConfig = (...more: string[]): string =>
  [
    'upload: public_html',
    'targets:',
    '  production:',
    '    server: ftp://deploy@ftp.example.com/www',
    `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
    '    url: https://example.com',
    ...more,
    '',
  ].join('\n');

describe('check on ftp:// (spec #41 decision 10)', () => {
  it('needs no host key: the target is ready', async () => {
    const project = createProject(ftpConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['check', 'production'], { cwd: project.root });
    expect(run.stderr).not.toContain('host key');
    expect(run.stderr).toContain('✓ Ready to deploy to production.');
    expect(run.exitCode).toBe(0);
  });
});

describe('init with an ftp:// server', () => {
  it('writes sealup.yml with no host key placeholder, and says nothing of keyscan', async () => {
    const root = newProject({ 'dist/index.html': 'x' });
    const run = await runMain(['init', '--server', 'ftp://deploy@ftp.example.com/www'], {
      cwd: root,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toBe(
      [
        'server: ftp://deploy@ftp.example.com/www',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: dist',
        '',
      ].join('\n'),
    );
    expect(run.stderr).not.toContain('keyscan');
    expect(run.stderr).toContain('server, password, upload: dist\n');
  });
});

describe('deploy over FTP: parallel counts connections (spec #41 decision 4)', () => {
  it.each([
    ['4 by default', [], 4],
    ['as parallel says', ['    parallel: 2'], 2],
  ])('opens %s', async (_, more, connections) => {
    const server = await ftpServer();
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`public_html/f${i}.txt`] = `file ${i}`;
    const project = createProject(ftpConfig(...more), files);
    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      connect: dialing(server),
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(server.logins()).toBe(connections);
    expect([...server.files().keys()].filter((path) => path.startsWith('/www/'))).toHaveLength(12);
  });

  it('names the connections it got in the job summary when the server allowed fewer (story 16)', async () => {
    const server = await ftpServer({ maxConnections: 2 });
    const project = createProject(ftpConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: { ...inGitHub },
      connect: dialing(server),
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.summary).toMatch(/ · FTP, 2 connections\n/);
  });
});

// Spec #41 decision 7, story 13: a secret file must get mode 0600 before its first byte (R17).
describe('deploy over FTP to a server that cannot set modes', () => {
  it('refuses the write entries before any change: exit 6, the reason', async () => {
    const server = await ftpServer({ siteChmod: false });
    const config = ftpConfig()
      .replace('ftp.example.com/www', 'ftp.example.com/site')
      .replace('targets:', `write:\n  api/.env: ${ref('APP_ENV')}\ntargets:`);
    const project = createProject(config, { 'public_html/index.html': 'x' });
    const run = await runMain(['deploy', 'production', '--json'], {
      cwd: project.root,
      env: { APP_ENV: 'APP_KEY=base64:not-a-real-key' },
      connect: dialing(server),
    });
    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain(
      [
        '  ✗ ftp.example.com cannot set file permissions: sealup stopped.',
        '    write.api/.env (line 3) writes /site/api/.env from a secret: it must get',
        '    its file mode before its first byte, and the server refused SITE CHMOD.',
        '    Deploy it over sftp:// instead, or remove that entry.',
        '',
        '    Nothing was changed on production.',
        '    More: sealup.dev/e/secret-file-public',
      ].join('\n'),
    );
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'blocked',
      error: { code: 'secret-file-public' },
    });
    expect([...server.files().keys()].filter((path) => path.startsWith('/site/'))).toEqual([]);
  });
});

describe('pull over FTP (spec #41 story 14)', () => {
  it('copies the server files here, with the plain-FTP warning', async () => {
    const server = await ftpServer();
    const config = ftpConfig().replace(
      'targets:',
      'pull:\n  uploads: public_html/uploads\ntargets:',
    );
    server.seedFile('/www/uploads/a.jpg', new Uint8Array([1, 2, 3]), { mtime: 1_700_000_000 });
    server.seedFile('/www/uploads/2024/b.jpg', new Uint8Array([4, 5]), { mtime: 1_700_000_000 });
    const project = createProject(config, { 'public_html/index.html': 'x' });
    const run = await runMain(['pull', 'production', '--no-color'], {
      cwd: project.root,
      tty: true,
      connect: dialing(server),
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(screenOf(run.stderr)).toContain(
      [
        '  production  ftp://deploy@ftp.example.com:21/www',
        '  host key    none (plain FTP has no host key)',
        '',
        '  ! Plain FTP: your password and files travel unencrypted.',
      ].join('\n'),
    );
    const here = (path: string) => [...readFileSync(join(project.root, 'public_html', path))];
    expect(here('uploads/a.jpg')).toEqual([1, 2, 3]);
    expect(here('uploads/2024/b.jpg')).toEqual([4, 5]);
  });
});

describe('keyscan on ftp:// (spec #41 decision 12)', () => {
  it('says plain FTP has no key to trust, scans nothing, exit 0', async () => {
    const project = createProject(ftpConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['keyscan', 'production'], {
      cwd: project.root,
      scan: () => Promise.reject(new Error('keyscan scanned an FTP server')),
    });
    expect(run.stderr).toBe(
      [
        versionLine('keyscan', 'production'),
        '  production  ftp://deploy@ftp.example.com:21/www',
        '  host key    none (plain FTP has no host key)',
        '',
        '  Plain FTP has no key to trust: there is nothing to save.',
        '    Most hosts also offer SFTP: write sftp:// in server (sealup.yml line 4).',
        '',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(0);
  });

  it('gives no key in --json', async () => {
    const project = createProject(ftpConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['keyscan', 'production', '--json'], { cwd: project.root });
    expect(JSON.parse(run.stdout)).toMatchObject({
      command: 'keyscan',
      target: 'production',
      server: 'ftp://deploy@ftp.example.com:21/www',
      status: 'ok',
      exitCode: 0,
      hostKey: null,
    });
    expect(run.exitCode).toBe(0);
  });
});
