// The risky-folder net through main() (decision 0029, spec #41 decision 30, R20, seam 1): with the
// mirror on, a target folder of `/` or `/~` stops the run before connecting, and one equal to the
// login folder right after login; exit 6, nothing changed, unless the target says
// `allow: [root-folder]`. Without the mirror, a deploy into the login folder runs as before
// (ruling 3): the owner's OVH shape, `public_html → www` and `api → api` from the login folder.

import { describe, expect, it } from 'vitest';
import type { ServerPath } from '../../src/contracts/index.ts';
import { createMemoryServer, goldenText } from '../../src/testkit/index.ts';
import { createProject, hostKeyLine, ref, runMain, versionLine } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

/**
 * The owner's OVH shape into `folder`: `public_html → www` (with `mirror: true` when asked) and
 * `api → api`; `allow: [root-folder]` when asked. The manifest is in `/srv/sealup`, outside the
 * login folder (R14 refuses the default one, in the login folder, inside such a target folder),
 * unless `manifest` is false: then the default.
 */
function ovhConfig(
  folder: string,
  options: { readonly mirror?: boolean; readonly allow?: boolean; readonly manifest?: false } = {},
): string {
  return [
    'upload:',
    ...(options.mirror === true
      ? ['  public_html:', '    to: www', '    mirror: true']
      : ['  public_html: www']),
    '  api: api',
    'targets:',
    '  production:',
    `    server: sftp://deploy@ssh.example.com:22${folder}`,
    `    password: ${ref('PROD_PASSWORD')}`,
    `    hostKey: ${hostKeyLine}`,
    ...(options.manifest === false ? [] : ['    manifest: /srv/sealup']),
    ...(options.allow === true ? ['    allow: [root-folder]'] : []),
    '',
  ].join('\n');
}

const build = { 'public_html/index.html': '<h1>v1</h1>', 'api/index.php': '<?php' };

/** A server whose login folder is `/home/deploy`, with `/srv` there for the manifest folder. */
function ovhServer() {
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  server.seedFile('/srv/README', 'the manifest folder goes here');
  return server;
}

describe('sealup deploy: the risky-folder net (R20, mirror only)', () => {
  it('refuses --mirror into the login folder (/~) before connecting, and exits 6', async () => {
    const project = createProject(ovhConfig('/~'), build);

    // No server: a run that connects fails the test.
    const run = await runMain(['deploy', '--mirror'], { cwd: project.root, env });

    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy'),
          '  {rb}✗{/} {b}The target folder /~ is the login folder: sealup stopped before connecting.{/}',
          '    With the mirror on, sealup deletes every file that is not in the build',
          '    from /~/api and /~/www.',
          '    It mirrors from the login folder only when you allow it.',
          '    Deploy into a folder inside it, or drop --mirror.',
          '    {d}To mirror it on purpose: allow: [root-folder] on the target.{/}',
          '',
          '    Nothing was changed on production.',
          '    {d}More: sealup.dev/e/risky-folder{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(6);
  });

  it('says the mirror reaches whatever else the account holds when it mirrors the login folder itself', async () => {
    const config = [
      'upload: public_html',
      'targets:',
      '  production:',
      '    server: sftp://deploy@ssh.example.com:22/~',
      `    password: ${ref('PROD_PASSWORD')}`,
      `    hostKey: ${hostKeyLine}`,
      '    manifest: /srv/sealup',
      '',
    ].join('\n');
    const project = createProject(config, { 'public_html/index.html': 'x' });

    const run = await runMain(['deploy', '--mirror'], { cwd: project.root, env });

    expect(run.stderr).toContain(
      [
        '  ✗ The target folder /~ is the login folder: sealup stopped before connecting.',
        '    With the mirror on, sealup deletes every file there that is not in the',
        '    build, whatever else the account holds.',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(6);
  });

  it("refuses mirror: true into the server's root (/) before connecting, naming its line", async () => {
    const project = createProject(ovhConfig('/', { mirror: true, manifest: false }), build);

    const run = await runMain(['deploy', '--json'], { cwd: project.root, env });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain(
      [
        "  ✗ The target folder / is the server's root: sealup stopped before connecting.",
        '    With the mirror on, sealup deletes every file that is not in the build',
        '    from /www.',
        "    It mirrors from the server's root only when you allow it.",
        '    Deploy into a folder inside it, or turn the mirror off (line 2).',
        '    To mirror it on purpose: allow: [root-folder] on the target.',
        '',
        '    Nothing was changed on production.',
        '    More: sealup.dev/e/risky-folder',
      ].join('\n'),
    );
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'blocked',
      exitCode: 6,
      error: { code: 'risky-folder' },
    });
  });

  it('refuses --mirror into a folder that is the login folder right after login', async () => {
    const project = createProject(ovhConfig('/home/deploy'), build);
    const server = ovhServer();
    server.seedFile('/home/deploy/www/old.php', 'old');
    server.seedFile('/home/deploy/mail/inbox', 'mail');
    const before = [...server.files().keys()].sort();

    const run = await runMain(['deploy', '--mirror'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain(
      [
        '  ✗ The target folder /home/deploy is the login folder: sealup stopped.',
        '    With the mirror on, sealup deletes every file that is not in the build',
        '    from /home/deploy/api and /home/deploy/www.',
        '    It mirrors from the login folder only when you allow it.',
        '    Deploy into a folder inside it, or drop --mirror.',
        '    To mirror it on purpose: allow: [root-folder] on the target.',
        '',
        '    Nothing was changed on production.',
        '    More: sealup.dev/e/risky-folder',
      ].join('\n'),
    );
    // Stopped before the lock: nothing at all was written.
    expect([...server.files().keys()].sort()).toEqual(before);
    expect(server.folders().filter((folder) => folder.startsWith('/srv/'))).toEqual([]);
  });

  it.each([
    ['/~', '--mirror'],
    ['/home/deploy', '--mirror'],
    ['/~', 'mirror: true'],
  ])('mirrors into %s with allow: [root-folder] (%s)', async (folder, how) => {
    const mirror = how === 'mirror: true';
    const project = createProject(ovhConfig(folder, { mirror, allow: true }), build);
    const server = ovhServer();
    server.seedFile('/home/deploy/www/old.php', 'old');

    const run = await runMain(['deploy', ...(mirror ? [] : ['--mirror'])], {
      cwd: project.root,
      env,
      server,
    });

    expect(run.exitCode).toBe(0);
    expect(server.files().has('/home/deploy/www/old.php' as ServerPath)).toBe(false);
    expect(server.files().has('/home/deploy/www/index.html' as ServerPath)).toBe(true);
  });

  it.each(['/~', '/home/deploy'])(
    'deploys into %s without the mirror as before (ruling 3)',
    async (folder) => {
      const project = createProject(ovhConfig(folder), build);
      const server = ovhServer();
      server.seedFile('/home/deploy/www/old.php', 'old');
      server.seedFile('/home/deploy/mail/inbox', 'mail');

      const run = await runMain(['deploy'], { cwd: project.root, env, server });

      expect(run.exitCode).toBe(0);
      const files = [...server.files().keys()].filter((path) => path.startsWith('/home/deploy/'));
      expect(files.sort()).toEqual([
        '/home/deploy/api/index.php',
        '/home/deploy/mail/inbox',
        '/home/deploy/www/index.html',
        '/home/deploy/www/old.php',
      ]);
    },
  );

  it('lets a single-file mapping with mirror: true into /~ through: nothing to mirror', async () => {
    const config = ovhConfig('/~').replace(
      '  api: api\n',
      '  api: api\n  robots.txt:\n    to: robots.txt\n    mirror: true\n',
    );
    const project = createProject(config, { ...build, 'robots.txt': 'User-agent: *' });
    const server = ovhServer();

    const run = await runMain(['deploy'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(0);
  });
});

describe('sealup check: the risky-folder net (R20)', () => {
  it('reports mirror: true into /~ as a deploy would stop on it, exit 6', async () => {
    const project = createProject(ovhConfig('/~', { mirror: true }), build);

    const run = await runMain(['check'], { cwd: project.root, env });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain('The target folder /~ is the login folder');
  });

  it('passes the same target with allow: [root-folder]', async () => {
    const project = createProject(ovhConfig('/~', { mirror: true, allow: true }), build);

    const run = await runMain(['check'], { cwd: project.root, env });

    expect(run.exitCode).toBe(0);
  });
});
