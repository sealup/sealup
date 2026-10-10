// R14 through main() (decision 0038, ruling 5 of plan 05, seam 1): the manifest folder may not
// be any mapping's server folder nor inside one (the folders visitors can reach); elsewhere in
// the target folder it is accepted. The owner's OVH shape, `public_html → www` and `api → api`
// from the login folder with the default manifest `/~/.sealup`, deploys, redeploys and deletes.
// A mapping into the target folder itself still refuses it (exit 2), and nothing that lists or
// deletes ever reaches the manifest folder or its lock.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerPath, Session } from '../../src/contracts/index.ts';
import { createMemoryServer, goldenText } from '../../src/testkit/index.ts';
import { createProject, hostKeyLine, ref, runMain, versionLine } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

/** The owner's OVH shape into `folder`, with the default manifest; `lines` added to the target. */
function ovhConfig(folder: string, upload: readonly string[], lines: readonly string[] = []) {
  return [
    'upload:',
    ...upload,
    'targets:',
    '  production:',
    `    server: sftp://deploy@ssh.example.com:22${folder}`,
    `    password: ${ref('PROD_PASSWORD')}`,
    `    hostKey: ${hostKeyLine}`,
    ...lines,
    '',
  ].join('\n');
}

const ovh = ['  public_html: www', '  api: api'];
const build = { 'public_html/index.html': '<h1>v1</h1>', 'api/index.php': '<?php' };

/** The files under the login folder `/home/deploy`, sorted. */
function homeFiles(server: ReturnType<typeof createMemoryServer>): string[] {
  return [...server.files().keys()].filter((path) => path.startsWith('/home/deploy/')).sort();
}

/** The manifest files in `/home/deploy/.sealup`: the default manifest folder. */
function manifests(server: ReturnType<typeof createMemoryServer>): string[] {
  return homeFiles(server).filter((path) => path.startsWith('/home/deploy/.sealup/'));
}

/** A connect to `server` that records every listing and delete its sessions make. */
function recording(server: ReturnType<typeof createMemoryServer>) {
  const calls: string[] = [];
  const connect = async (): Promise<Session> => {
    const session = await server.connect();
    return {
      ...session,
      list: (folder, max) => {
        calls.push(`list ${folder}`);
        return session.list(folder, max);
      },
      remove: (path) => {
        calls.push(`remove ${path}`);
        return session.remove(path);
      },
      rmdir: (path) => {
        calls.push(`rmdir ${path}`);
        return session.rmdir(path);
      },
    };
  };
  return { calls, connect };
}

const manifestFolder = '/home/deploy/.sealup';

describe('R14: the manifest folder out of the web roots (decision 0038)', () => {
  it('deploys, redeploys and deletes the OVH shape into /~ with the default manifest', async () => {
    const project = createProject(ovhConfig('/~', ovh), { ...build, 'api/old.php': '<?php' });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.seedFile('/home/deploy/mail/inbox', 'mail');

    const first = await runMain(['deploy'], { cwd: project.root, env, server });
    expect(first.exitCode, first.stderr).toBe(0);
    const [manifest, ...others] = manifests(server);
    expect(manifest).toMatch(/^\/home\/deploy\/\.sealup\/[^/]+\.json$/);
    expect(others).toEqual([]);
    expect(homeFiles(server)).toEqual([
      manifest,
      '/home/deploy/api/index.php',
      '/home/deploy/api/old.php',
      '/home/deploy/mail/inbox',
      '/home/deploy/www/index.html',
    ]);

    writeFileSync(join(project.root, 'public_html', 'about.html'), '<h1>about</h1>');
    rmSync(join(project.root, 'api', 'old.php'));
    const again = await runMain(['deploy'], { cwd: project.root, env, server });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stderr).toContain('1 old file removed');
    expect(homeFiles(server)).toEqual([
      manifest,
      '/home/deploy/api/index.php',
      '/home/deploy/mail/inbox',
      '/home/deploy/www/about.html',
      '/home/deploy/www/index.html',
    ]);
    // The lock (decision 0031) was taken in the manifest folder and released.
    expect(server.folders().filter((folder) => folder.endsWith('.lock'))).toEqual([]);
  });

  it('still refuses a mapping into /~ itself with the default manifest: exit 2, its line', async () => {
    const project = createProject(ovhConfig('/~', [...ovh, '  site: .']), {
      ...build,
      'site/.ovhconfig': 'app.engine=php',
    });

    // No server: a run that connects fails the test.
    const run = await runMain(['deploy'], { cwd: project.root, env });

    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy'),
          '  {rb}✗{/} {b}The manifest folder is inside the target folder: sealup stopped.{/}',
          '    /~/.sealup is in /~, where upload: sends files (line 4):',
          '    visitors could download it.',
          '    The login folder is in it, so the default .sealup is too: send that',
          '    upload into a folder of its own (to: www), or set manifest: outside it.',
          '',
          '    sealup did not connect. Nothing was changed on production.',
          '    {d}More: sealup.dev/e/manifest-inside-target{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(2);
  });

  it('refuses a manifest folder inside a mapping into a subfolder, naming that folder', async () => {
    const project = createProject(ovhConfig('/~', ovh, ['    manifest: www/.sealup']), build);

    const run = await runMain(['deploy'], { cwd: project.root, env });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      [
        '  ✗ The manifest folder is inside /~/www: sealup stopped.',
        '    /~/www/.sealup is in /~/www, where upload: sends files (line 2):',
        '    visitors could download it.',
      ].join('\n'),
    );
  });

  it('decides after login: the OVH shape into /home/deploy deploys, one into it stops', async () => {
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const ok = createProject(ovhConfig('/home/deploy', ovh), build);
    const deployed = await runMain(['deploy'], { cwd: ok.root, env, server });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(manifests(server)).toHaveLength(1);

    const into = createProject(ovhConfig('/home/deploy', ['  site: .']), { 'site/a.txt': 'a' });
    const before = homeFiles(server);
    const stopped = await runMain(['deploy'], { cwd: into.root, env, server });
    expect(stopped.exitCode).toBe(2);
    expect(stopped.stderr).toContain(
      [
        '  ✗ The manifest folder is inside the target folder: sealup stopped.',
        '    /home/deploy/.sealup is in /home/deploy, where upload: sends files (line 2):',
        '    visitors could download it.',
        '    The login folder is in it, so the default .sealup is too: send that',
        '    upload into a folder of its own (to: www), or set manifest: outside it.',
        '',
        '    Nothing was changed on production.',
      ].join('\n'),
    );
    expect(homeFiles(server)).toEqual(before);
  });

  it('lets a single file sit beside the manifest folder; its own path still clashes', async () => {
    const beside = createProject(ovhConfig('/~', [...ovh, '  .ovhconfig: .ovhconfig']), {
      ...build,
      '.ovhconfig': 'app.engine=php',
    });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const deployed = await runMain(['deploy'], { cwd: beside.root, env, server });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(server.files().has('/home/deploy/.ovhconfig' as ServerPath)).toBe(true);
    expect(manifests(server)).toHaveLength(1);

    const clash = createProject(ovhConfig('/~', [...ovh, '  notes.txt: .sealup']), {
      ...build,
      'notes.txt': 'notes',
    });
    const stopped = await runMain(['deploy'], { cwd: clash.root, env });
    expect(stopped.exitCode).toBe(2);
    expect(stopped.stderr).toContain('The manifest folder is inside /~/.sealup: sealup stopped.');
  });

  it('never lists or deletes in the manifest folder: --mirror and --check-server on /~', async () => {
    const config = ovhConfig('/~', ovh, ['    allow: [root-folder]']);
    const project = createProject(config, build);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    expect((await runMain(['deploy'], { cwd: project.root, env, server })).exitCode).toBe(0);
    const [manifest] = manifests(server);
    server.seedFile('/home/deploy/www/stray.html', 'stray');
    server.seedFile(`${manifestFolder}/notes.txt`, 'kept by hand');
    server.seedFile('/home/deploy/mail/inbox', 'mail');
    const { calls, connect } = recording(server);

    const run = await runMain(['deploy', '--mirror', '--check-server'], {
      cwd: project.root,
      env,
      connect,
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(server.files().has('/home/deploy/www/stray.html' as ServerPath)).toBe(false);
    expect(homeFiles(server)).toEqual([
      manifest,
      `${manifestFolder}/notes.txt`,
      '/home/deploy/api/index.php',
      '/home/deploy/mail/inbox',
      '/home/deploy/www/index.html',
    ]);
    // The mirror lists www and api only; the server check lists the manifest folder for the
    // manifest's date alone; the only deletes there are the lock's own release.
    const inManifestFolder = calls.filter((call) => call.includes(manifestFolder));
    expect(inManifestFolder.filter((call) => call.startsWith('list '))).toEqual([
      `list ${manifestFolder}`,
    ]);
    for (const call of inManifestFolder.filter((call) => !call.startsWith('list '))) {
      expect(call).toMatch(
        /^(remove|rmdir) \/home\/deploy\/\.sealup\/[^/]+\.json\.lock(\/note\.json)?$/,
      );
    }
    expect(calls).not.toContain('list /home/deploy');
  });

  it('stops a mirrored mapping into the target folder itself before listing anything', async () => {
    const config = ovhConfig('/home/deploy', ['  site: .'], ['    allow: [root-folder]']);
    const project = createProject(config, { 'site/a.txt': 'a' });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.seedFile(`${manifestFolder}/old.json`, '{}');
    server.seedFile(`${manifestFolder}/old.json.lock/note.json`, '{}');
    server.seedFile('/home/deploy/stray.html', 'stray');
    const before = homeFiles(server);
    const { calls, connect } = recording(server);

    const run = await runMain(['deploy', '--mirror'], { cwd: project.root, env, connect });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('The manifest folder is inside the target folder');
    expect(calls).toEqual([]);
    expect(homeFiles(server)).toEqual(before);
  });
});

describe('R14 in sealup check and a converted sam-sync project (decision 0038)', () => {
  it('check passes the OVH shape into /~ with the default manifest, and refuses one into /~', async () => {
    const ok = createProject(ovhConfig('/~', ovh), build);
    const passed = await runMain(['check'], { cwd: ok.root, env });
    expect(passed.exitCode, passed.stderr).toBe(0);

    const into = createProject(ovhConfig('/~', ['  site: .']), { 'site/a.txt': 'a' });
    const refused = await runMain(['check'], { cwd: into.root, env });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('The manifest folder is inside the target folder');
  });
});
