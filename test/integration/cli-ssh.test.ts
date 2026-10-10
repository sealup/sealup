// `sealup deploy` to an `ssh://` target through main() (seam 1), over the in-process server and
// the real transport (0034, spec #41 decisions 13 and 15): changed files travel as one archive
// into the server's `tar`, under temp names renamed over SFTP at the end, or under their real
// names into an empty folder; a server without `tar` or a shell goes file by file and says so.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerPath } from '../../src/contracts/index.ts';
import {
  canaries,
  createSftpServer,
  expectNoLeaks,
  type SftpServer,
} from '../../src/testkit/index.ts';
import { createProject, hostKeyLine, onlyOnce, productionConfig, runMain } from '../deploy-kit.ts';
import { dialing, scanDialing, sftpTarget, testSession } from '../sftp-kit.ts';

const site = {
  'public_html/index.html': '<h1>home</h1>',
  'public_html/my pages/about us.html': '<h1>about</h1>',
  'public_html/assets/app.js': 'x'.repeat(100_000),
};

/** The archive's probe after login (0039): a marker only with both tar and gzip. */
const probe = 'command -v tar >/dev/null && command -v gzip >/dev/null && echo sealup-archive-ok';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sshServer(
  shell?: 'tar' | 'no-tar' | 'no-gzip' | 'no-shell',
  now?: () => number,
): Promise<SftpServer> {
  const server = await createSftpServer({
    password: canaries.SEALUP_CANARY_PASSWORD,
    ...(shell === undefined ? {} : { shell }),
    ...(now === undefined ? {} : { now }),
  });
  cleanups.push(() => server.stop());
  return server;
}

/** The page's project on `ssh://`, pinning `server`'s key and reading the canary password. */
function projectFor(server: SftpServer, files: Record<string, string> = site) {
  const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' })
    .replace(hostKeyLine, server.hostKeyLine)
    .replace('sftp://', 'ssh://');
  return createProject(config, files);
}

const siteFiles = (server: SftpServer): Record<string, string> =>
  Object.fromEntries(
    [...server.files()]
      .filter(([path]) => path.startsWith('/home/site/'))
      .map(([path, file]) => [
        path.slice('/home/site/'.length),
        new TextDecoder().decode(file.bytes),
      ]),
  );

const transferLine = (stderr: string): string | undefined =>
  stderr.split('\n').find((line) => line.trimStart().startsWith('transfer'));

describe('sealup deploy over ssh://', () => {
  it('sends a first deploy as one archive under the real names, into the new folder', async () => {
    const ssh = await sshServer();
    const project = projectFor(ssh);
    const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) });

    expect(run.exitCode).toBe(0);
    expect(transferLine(run.stderr)).toBe(
      '  transfer    changed files travel as one archive over SSH',
    );
    expect(ssh.commands()).toEqual([probe, "tar -xmzf - -C '/home/site'"]);
    expect(ssh.archives()).toEqual([['assets/app.js', 'index.html', 'my pages/about us.html']]);
    expect(siteFiles(ssh)).toEqual({
      'assets/app.js': site['public_html/assets/app.js'],
      'index.html': '<h1>home</h1>',
      'my pages/about us.html': '<h1>about</h1>',
    });
    expectNoLeaks(Object.fromEntries([...ssh.files()].map(([path, file]) => [path, file.bytes])));
  });

  it('sends a redeploy under temp names, then renames them: no temp file is left', async () => {
    const ssh = await sshServer();
    const project = projectFor(ssh);
    expect((await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) })).exitCode).toBe(
      0,
    );
    const changed = projectFor(ssh, { ...site, 'public_html/index.html': '<h1>new home</h1>' });
    const run = await runMain(['deploy'], { cwd: changed.root, connect: dialing(ssh) });

    expect(run.exitCode).toBe(0);
    const [, second] = ssh.archives();
    expect(second).toHaveLength(1);
    expect(second?.[0]).toMatch(/^\.index\.html\.sealup-[0-9a-f]{16}\.tmp$/);
    expect(Object.keys(siteFiles(ssh)).sort()).toEqual([
      'assets/app.js',
      'index.html',
      'my pages/about us.html',
    ]);
    expect(siteFiles(ssh)['index.html']).toBe('<h1>new home</h1>');
  });

  // R15: nothing from a file name reaches a command; each stays a file.
  it("deploys files named a'b.php, $(touch pwned) and -rf as files; pwned never appears", async () => {
    const ssh = await sshServer();
    const hostile = {
      "public_html/a'b.php": 'q',
      'public_html/$(touch pwned)': 'p',
      'public_html/-rf': 'r',
    };
    const project = projectFor(ssh, hostile);
    const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) });

    expect(run.exitCode).toBe(0);
    expect(siteFiles(ssh)).toEqual({ "a'b.php": 'q', '$(touch pwned)': 'p', '-rf': 'r' });
    expect(ssh.commands()).toEqual([probe, "tar -xmzf - -C '/home/site'"]);
    expect(
      [...ssh.files().keys(), ...ssh.folders()].filter((path) => path.endsWith('/pwned')),
    ).toEqual([]);
  });

  it.each([
    ['no tar', 'no-tar', [probe]],
    ['tar but no gzip', 'no-gzip', [probe]],
    ['no shell', 'no-shell', [probe]],
  ] as const)(
    'goes file by file over SFTP on a server with %s, and says so',
    async (_, shell, asked) => {
      const ssh = await sshServer(shell);
      const project = projectFor(ssh);
      const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) });

      expect(run.exitCode).toBe(0);
      expect(transferLine(run.stderr)).toBe(
        '  transfer    file by file over SFTP (no tar on the server)',
      );
      expect(ssh.commands()).toEqual(asked);
      expect(ssh.archives()).toEqual([]);
      expect(Object.keys(siteFiles(ssh))).toHaveLength(3);
    },
  );

  // R15: a login folder outside the command set never reaches a command, so there is no probe
  // and no archive; the line says why, not that the server lacks tar.
  it('goes file by file when the login folder may not go in a command, and says so', async () => {
    const ssh = await createSftpServer({
      password: canaries.SEALUP_CANARY_PASSWORD,
      loginFolder: '/home/my deploy',
    });
    cleanups.push(() => ssh.stop());
    const run = await runMain(['deploy'], { cwd: projectFor(ssh).root, connect: dialing(ssh) });

    expect(run.exitCode).toBe(0);
    expect(transferLine(run.stderr)).toBe(
      "  transfer    file by file over SFTP (the login folder's name is not safe in a command)",
    );
    expect(ssh.commands()).toEqual([]);
    expect(Object.keys(siteFiles(ssh))).toHaveLength(3);
  });

  it('records nothing of a failed archive and removes its temp names; the old files stay', async () => {
    const ssh = await sshServer();
    const project = projectFor(ssh);
    expect((await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) })).exitCode).toBe(
      0,
    );
    const before = siteFiles(ssh);
    const changed = projectFor(ssh, {
      ...site,
      'public_html/index.html': '<h1>new home</h1>',
      'public_html/new.html': 'new',
    });
    ssh.faults.failArchive();
    const failed = await runMain(['deploy'], { cwd: changed.root, connect: dialing(ssh) });

    expect(failed.exitCode).toBe(5);
    expect(failed.stderr).toContain('no space left');
    expect(siteFiles(ssh)).toEqual(before);
    // The rerun sends both again: none was recorded.
    const rerun = await runMain(['deploy', '--json'], { cwd: changed.root, connect: dialing(ssh) });
    expect(JSON.parse(rerun.stdout)).toMatchObject({ uploaded: 2 });
    expect(siteFiles(ssh)['index.html']).toBe('<h1>new home</h1>');
  });

  // Into an empty folder the archive writes real names, so a failed one may have left some:
  // the server may have changed, and the rerun finishes the job (exit 1, not 5).
  it('counts a failed first archive into an empty folder as a change: exit 1', async () => {
    const ssh = await sshServer();
    const session = await testSession(sftpTarget(ssh));
    await session.mkdir('/home/site' as ServerPath);
    // Files at the top only: no folder to make, so only the archive could change the server.
    const flat = {
      'public_html/index.html': 'i',
      'public_html/a.js': 'a',
      'public_html/b.css': 'b',
    };
    const project = projectFor(ssh, flat);
    ssh.faults.failArchive();
    const failed = await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) });

    expect(failed.exitCode).toBe(1);
    const rerun = await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) });
    expect(rerun.exitCode).toBe(0);
    expect(Object.keys(siteFiles(ssh))).toHaveLength(3);
  });

  // Spec #41 decision 26 compares a file's date with the manifest's, both on the server's clock.
  // The archive's files must be dated by the server too (tar -m), or with this machine's clock
  // ahead every one of them would look edited on the server, on every run.
  it('--check-server finds nothing changed after an archive, with this machine an hour ahead', async () => {
    const ssh = await sshServer(undefined, () => Date.now() - 3_600_000);
    const project = projectFor(ssh);
    expect((await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) })).exitCode).toBe(
      0,
    );
    const changed = projectFor(ssh, { ...site, 'public_html/index.html': '<h1>new home</h1>' });
    expect((await runMain(['deploy'], { cwd: changed.root, connect: dialing(ssh) })).exitCode).toBe(
      0,
    );

    const run = await runMain(['deploy', '--check-server', '--json'], {
      cwd: changed.root,
      connect: dialing(ssh),
    });

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'unchanged' });
  });

  // What a failed archive put under real names is sealup's (the folder was empty): a file there
  // whole is recorded, so a later build without it deletes it; a part of one is removed. Nothing
  // is left that no manifest knows.
  it('records the files a failed first archive left whole, and removes the part of one', async () => {
    const ssh = await sshServer();
    const session = await testSession(sftpTarget(ssh));
    await session.mkdir('/home/site' as ServerPath);
    // In archive order: a.js, b.css, then index.html, which the full disk cuts in half.
    const flat = {
      'public_html/a.js': 'aaaa',
      'public_html/b.css': 'bbbb',
      'public_html/index.html': 'iiii',
    };
    ssh.faults.failArchive();
    const failed = await runMain(['deploy'], {
      cwd: projectFor(ssh, flat).root,
      connect: dialing(ssh),
    });
    expect(failed.exitCode).toBe(1);
    expect(siteFiles(ssh)).toEqual({ 'a.js': 'aaaa', 'b.css': 'bbbb' });

    const { 'public_html/b.css': _, ...without } = flat;
    const next = await runMain(['deploy', '--json'], {
      cwd: projectFor(ssh, without).root,
      connect: dialing(ssh),
    });
    expect(next.exitCode).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ uploaded: 1, deleted: 1 });
    expect(siteFiles(ssh)).toEqual({ 'a.js': 'aaaa', 'index.html': 'iiii' });
  });

  it('leaves the old files in place when the connection drops during the archive', async () => {
    const ssh = await sshServer();
    const project = projectFor(ssh);
    expect((await runMain(['deploy'], { cwd: project.root, connect: dialing(ssh) })).exitCode).toBe(
      0,
    );
    const before = siteFiles(ssh);
    const changed = projectFor(ssh, { ...site, 'public_html/assets/app.js': 'y'.repeat(100_000) });
    ssh.faults.dropArchive();
    // The connection does not come back: the reconnect's tries (spec #41 decision 20) fail.
    const dropped = await runMain(['deploy'], {
      cwd: changed.root,
      connect: onlyOnce(dialing(ssh)),
    });

    expect(dropped.exitCode).toBe(5);
    expect(dropped.stderr).toContain('the connection to ssh.example.com was lost');
    expect(siteFiles(ssh)).toEqual(before);
  });
});

describe("ssh:// keeps sftp://'s rules (R7)", () => {
  /** The page's project on ssh://, with no hostKey line. */
  const unpinned = () =>
    createProject(
      productionConfig({ password: 'SEALUP_CANARY_PASSWORD', hostKey: false }).replace(
        'sftp://',
        'ssh://',
      ),
      site,
    );

  it('stops before connecting without a pinned host key (exit 4)', async () => {
    const ssh = await sshServer();
    const run = await runMain(['deploy'], { cwd: unpinned().root, connect: dialing(ssh) });

    expect(run.exitCode).toBe(4);
    expect(ssh.logins()).toEqual([]);
    expect(ssh.commands()).toEqual([]);
  });

  it('keyscan shows and saves the key of an ssh:// server, logging in to nothing', async () => {
    const ssh = await sshServer();
    const project = unpinned();
    const run = await runMain(['keyscan'], {
      cwd: project.root,
      tty: true,
      keys: ['y', '\r'],
      scan: scanDialing(ssh),
    });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(ssh.fingerprint);
    expect(readFileSync(project.config, 'utf8')).toContain(`hostKey: ${ssh.hostKeyLine}\n`);
    expect(ssh.logins()).toEqual([]);
  });
});
