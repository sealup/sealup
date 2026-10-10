// End to end against a real OpenSSH server in a container (ticket 11, decision 0013): the built
// bundle deploys a project, then redeploys it with a change, a new file and a delete; after each
// run the server's tree (paths, sizes, SHA-256, computed on the server) must be the local one.
// Every run is under the leak test (R1): the canary password is the login password, and it shows
// in no output and no file on the server, the manifest included. A file written from the
// multi-line canary arrives with mode 0600 and a redeploy leaves it alone (R17). The canary key
// logs in through `authorized_keys`; a key the server does not hold is refused, exit 3 (decision
// 0033). The same server
// then runs the Session contract suite: it is the one server that announces posix-rename.
//
// Runs where Docker runs Linux containers: always on Linux (a missing Docker fails the run), on
// other systems only when Docker answers with Linux (so Windows CI skips it).

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from '../../scripts/build.ts';
import type { ServerPath } from '../../src/contracts/index.ts';
import { parseServerPath } from '../../src/paths/index.ts';
import {
  archiveContract,
  canaries,
  canaryKeyLine,
  expectNoLeaks,
  readTree,
  sessionContract,
  userKey,
} from '../../src/testkit/index.ts';
import { connect, scanHostKey } from '../../src/transport/index.ts';
import { runCli } from '../cli-kit.ts';
import { createProject, ref, runMain } from '../deploy-kit.ts';
import {
  dockerRunsLinux,
  type FileFacts,
  type OpenSshServer,
  startOpenSsh,
} from '../openssh-kit.ts';
import { serverUrlOf, sftpTarget, sshTarget } from '../sftp-kit.ts';

const enabled = process.platform === 'linux' || dockerRunsLinux();

/** A site with nested folders, spaces, a hashed bundle, an empty file and a few large files. */
function site(): Record<string, Uint8Array> {
  const text = (value: string) => new TextEncoder().encode(value);
  const bytes = (seed: number, size: number) =>
    Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed * 7 + (i >> 8)) % 256);
  const files: Record<string, Uint8Array> = {
    'public_html/index.html': text('<h1>home</h1>\n'),
    'public_html/my pages/about us.html': text('<h1>about</h1>\n'),
    'public_html/empty.txt': new Uint8Array(),
    'public_html/assets/main.4f2a9c1e.js': bytes(1, 1_500_000),
    'public_html/assets/video.mp4': bytes(2, 3_000_000),
    'public_html/old/legacy.html': text('<p>gone soon</p>\n'),
  };
  for (let i = 0; i < 120; i++) {
    files[`public_html/vendor/pkg${i % 12}/src/file${i}.php`] = bytes(i + 10, 200 + i * 97);
  }
  return files;
}

/** The paths, sizes and SHA-256 of the files under a local folder, computed here. */
async function localTree(folder: string): Promise<Map<string, FileFacts>> {
  const files = Object.entries(await readTree(folder)).sort(([a], [b]) => (a < b ? -1 : 1));
  return new Map(
    files.map(([path, bytes]) => [
      path,
      { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]),
  );
}

/** The folders that hold those files (each parent, without the top folder itself). */
function foldersOf(tree: ReadonlyMap<string, unknown>): string[] {
  const folders = new Set<string>();
  for (const path of tree.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return [...folders].sort();
}

describe.runIf(enabled)('OpenSSH server in a container', () => {
  let server: OpenSshServer;
  let outdir = '';

  beforeAll(async () => {
    outdir = mkdtempSync(join(tmpdir(), 'sealup-e2e-'));
    [server] = await Promise.all([
      startOpenSsh({ password: canaries.SEALUP_CANARY_PASSWORD, authorizedKey: canaryKeyLine }),
      build({ outdir }),
    ]);
  });
  afterAll(async () => {
    await server?.stop();
    rmSync(outdir, { recursive: true, force: true });
  });

  /** The target folder on the server holds exactly the local build output: files and folders. */
  async function expectSameTree(local: string): Promise<void> {
    const expected = await localTree(local);
    expect(await server.tree('site')).toEqual(expected);
    expect(await server.folders('site')).toEqual(foldersOf(expected));
  }

  it('sealup deploy, then a redeploy with a change, a new file and a delete: the server holds the local tree', async () => {
    const config = [
      'upload: public_html',
      'targets:',
      '  production:',
      `    server: sftp://deploy@${server.host}:${server.port}/~/site`,
      `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      `    hostKey: ${server.hostKeyLine}`,
      '',
    ].join('\n');
    const project = createProject(config, site());
    const output = join(project.root, 'public_html');
    const cli = join(outdir, 'cli.mjs');

    const first = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(first.exitCode, first.stderr).toBe(0);
    await expectSameTree(output);

    // A change (new size), a new file in a new folder, and a delete that empties a folder.
    writeFileSync(join(output, 'index.html'), '<h1>home, version 2</h1>\n');
    mkdirSync(join(output, 'api'));
    writeFileSync(join(output, 'api', 'new file.json'), '{"new":true}\n');
    rmSync(join(output, 'old'), { recursive: true });
    const redeploy = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(redeploy.exitCode, redeploy.stderr).toBe(0);
    await expectSameTree(output);
    expect((await server.tree('site')).get('index.html')?.size).toBe(25);
    expect(await server.folders('site')).not.toContain('old');

    // The manifest is alone in its own folder, outside the target folder; no file anywhere in
    // the login folder holds the canary in any form.
    const manifests = [...(await server.tree('.sealup')).keys()];
    expect(manifests).toEqual([expect.stringMatching(/^[a-z0-9-]+\.json$/)]);
    expectNoLeaks(await server.files('.'));
  });

  it('writes a file from a multi-line secret with mode 0600, and a redeploy leaves it alone (R17)', async () => {
    await server.clear();
    const config = [
      `server: sftp://deploy@${server.host}:${server.port}/~/site`,
      `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      `hostKey: ${server.hostKeyLine}`,
      'upload: public_html',
      'write:',
      `  api/.env: ${ref('SEALUP_CANARY_MULTILINE')}`,
      '',
    ].join('\n');
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>\n' });
    const cli = join(outdir, 'cli.mjs');

    const first = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(first.exitCode, first.stderr).toBe(0);
    const secret = canaries.SEALUP_CANARY_MULTILINE;
    expect((await server.tree('site')).get('api/.env')).toEqual({
      size: Buffer.byteLength(secret),
      sha256: createHash('sha256').update(secret).digest('hex'),
    });
    const written = await server.stat('site/api/.env');
    expect(written.mode).toBe(0o600);

    const again = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stderr).toContain('Already up to date: 2 files checked');
    // Not put again: the same file (inode), still 0600.
    expect(await server.stat('site/api/.env')).toEqual(written);

    // The secret is in that one file and nowhere else: not in the manifest, not in a temp file.
    const { 'site/api/.env': _, ...others } = await server.files('.');
    expect(Object.keys(others).some((path) => path.includes('.sealup-'))).toBe(false);
    expectNoLeaks(others);
  });

  it('logs in with a private key from authorized_keys; a key it does not hold is refused, exit 3 (0033)', async () => {
    await server.clear();
    const config = (variable: string) =>
      [
        `server: sftp://deploy@${server.host}:${server.port}/~/site`,
        `privateKey: ${ref(variable)}`,
        `hostKey: ${server.hostKeyLine}`,
        'upload: public_html',
        '',
      ].join('\n');
    const cli = join(outdir, 'cli.mjs');

    // The canary key: runCli's leak check covers every line of it in the output.
    const project = createProject(config('SEALUP_CANARY_KEY'), site());
    const deployed = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    await expectSameTree(join(project.root, 'public_html'));
    expectNoLeaks(await server.files('.'));

    const other = createProject(config('OTHER_KEY'), { 'public_html/index.html': 'x' });
    const refused = await runCli([cli, 'deploy'], {
      cwd: other.root,
      env: { OTHER_KEY: userKey().private },
    });
    expect(refused.exitCode, refused.stderr).toBe(3);
    expect(refused.stderr).toContain('Login refused by 127.0.0.1 for user deploy.');
  });

  it('sealup pull copies the target folder here, checked by SHA-256; a second pull finds it all here', async () => {
    await server.clear();
    const config = [
      `server: sftp://deploy@${server.host}:${server.port}/~/site`,
      `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      `hostKey: ${server.hostKeyLine}`,
      'upload: public_html',
      'pull:',
      '  .: pulled',
      '',
    ].join('\n');
    const project = createProject(config, site());
    const cli = join(outdir, 'cli.mjs');
    const deployed = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(deployed.exitCode, deployed.stderr).toBe(0);

    // A pull runs only on a terminal (0023 §7): through main() in this process, as a person
    // would, with the real transport.
    const pulled = await runMain(['pull'], { cwd: project.root, tty: true, connect });
    expect(pulled.exitCode, pulled.stderr).toBe(0);
    expect(await localTree(join(project.root, 'pulled'))).toEqual(await server.tree('site'));

    const again = await runMain(['pull'], { cwd: project.root, tty: true, connect });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stderr).toMatch(/Already here:\S* 126 files checked against 127\.0\.0\.1 in /);
  });

  // ssh:// (0034): the same build as one archive into Debian's GNU tar, then a redeploy under temp
  // names; files named as shell code stay files (R15), and nothing else appears on the server.
  it('sealup deploy over ssh://: one archive into GNU tar, then a redeploy by temp names and renames', async () => {
    await server.clear();
    const hostile = {
      "public_html/a'b.php": "<?php echo 'q';\n",
      'public_html/$(touch pwned)': 'p\n',
      'public_html/-rf': 'r\n',
      'public_html/--checkpoint-action=exec=sh': 'c\n',
    };
    const config = [
      `server: ssh://deploy@${server.host}:${server.port}/~/site`,
      `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      `hostKey: ${server.hostKeyLine}`,
      'upload: public_html',
      '',
    ].join('\n');
    const project = createProject(config, { ...site(), ...hostile });
    const output = join(project.root, 'public_html');
    const cli = join(outdir, 'cli.mjs');

    const first = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stderr).toContain('transfer    changed files travel as one archive over SSH');
    await expectSameTree(output);

    writeFileSync(join(output, 'index.html'), '<h1>home, version 2</h1>\n');
    writeFileSync(join(output, '-rf'), 'still a file\n');
    mkdirSync(join(output, 'api'));
    writeFileSync(join(output, 'api', 'new file.json'), '{"new":true}\n');
    rmSync(join(output, 'old'), { recursive: true });
    const redeploy = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(redeploy.exitCode, redeploy.stderr).toBe(0);
    await expectSameTree(output);
    const everything = [...(await server.tree('.')).keys(), ...(await server.folders('.'))];
    expect(everything.filter((path) => path.endsWith('pwned') && !path.includes('$('))).toEqual([]);
    expect(everything.filter((path) => path.includes('.sealup-'))).toEqual([]);
    expectNoLeaks(await server.files('.'));
  });

  // 0039: 1,200 files travel over several streams (four `tar`s side by side), first under their
  // real names into the new folder, then 700 changed ones under temp names renamed after.
  it('sealup deploy over ssh:// of 1,200 files: several streams, then a redeploy by temp names', async () => {
    await server.clear();
    const many: Record<string, string> = {};
    for (let i = 0; i < 1_200; i++) many[`public_html/p${i % 40}/f${i}.txt`] = `file ${i}\n`;
    const config = [
      `server: ssh://deploy@${server.host}:${server.port}/~/site`,
      `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      `hostKey: ${server.hostKeyLine}`,
      'upload: public_html',
      '',
    ].join('\n');
    const project = createProject(config, many);
    const output = join(project.root, 'public_html');
    const cli = join(outdir, 'cli.mjs');

    const first = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(first.exitCode, first.stderr).toBe(0);
    await expectSameTree(output);

    for (let i = 0; i < 700; i++) {
      writeFileSync(join(output, `p${i % 40}`, `f${i}.txt`), `file ${i}, version 2\n`);
    }
    const redeploy = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(redeploy.exitCode, redeploy.stderr).toBe(0);
    await expectSameTree(output);
    expect(
      [...(await server.tree('.')).keys()].filter((path) => path.includes('.sealup-')),
    ).toEqual([]);
  });

  // R16 (spec #41 decision 27): a real server follows a link, and so would `tar`; sealup looks
  // first and stops, so outside/ is never written. Both protocols, through main() and transport.
  it.each(['sftp', 'ssh'])(
    '%s://: site/api → ../outside stops the run before any change, exit 6, and outside/ stays as it was',
    async (protocol) => {
      await server.clear();
      const configFor = (folder: string, upload: string) =>
        [
          `server: ${protocol}://deploy@${server.host}:${server.port}/~/${folder}`,
          `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `hostKey: ${server.hostKeyLine}`,
          `upload: ${upload}`,
          '',
        ].join('\n');
      const outside = createProject(configFor('outside', 'files'), {
        'files/keep.txt': 'not the site\n',
      });
      expect((await runMain(['deploy'], { cwd: outside.root, connect })).exitCode).toBe(0);
      const project = createProject(configFor('site', 'public_html'), {
        'public_html/index.html': '<h1>home</h1>\n',
      });
      expect((await runMain(['deploy'], { cwd: project.root, connect })).exitCode).toBe(0);
      await server.seedLink('/home/deploy/site/api', '../outside');
      const before = { site: await server.tree('site'), outside: await server.tree('outside') };
      writeFileSync(join(project.root, 'public_html', 'index.html'), '<h1>home, version 2</h1>\n');
      mkdirSync(join(project.root, 'public_html', 'api'));
      writeFileSync(join(project.root, 'public_html', 'api', 'keep.txt'), 'overwritten\n');

      const run = await runMain(['deploy'], { cwd: project.root, connect });

      expect(run.exitCode, run.stderr).toBe(6);
      expect(run.stderr).toContain('/home/deploy/site/api is a symlink on the server');
      expect(await server.tree('outside')).toEqual(before.outside);
      expect(await server.tree('site')).toEqual(before.site);
    },
  );

  // Spec #41 decision 28: with `allow: [symlinks]`, a recorded folder someone replaced by a link
  // is left alone. A real server follows the link, so deleting the recorded file would delete
  // outside/x.txt: sealup keeps it instead, and the link stays a link.
  it.each(['sftp', 'ssh'])(
    '%s:// with allow: [symlinks]: site/old → ../outside is left alone, and outside/ keeps its files',
    async (protocol) => {
      await server.clear();
      const configFor = (folder: string, upload: string, allow = '') =>
        [
          `server: ${protocol}://deploy@${server.host}:${server.port}/~/${folder}`,
          `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `hostKey: ${server.hostKeyLine}`,
          `upload: ${upload}`,
          allow,
          '',
        ].join('\n');
      const outside = createProject(configFor('outside', 'files'), {
        'files/x.txt': 'not the site\n',
      });
      expect((await runMain(['deploy'], { cwd: outside.root, connect })).exitCode).toBe(0);
      const project = createProject(configFor('site', 'public_html', 'allow: [symlinks]'), {
        'public_html/index.html': '<h1>home</h1>\n',
        'public_html/old/x.txt': 'old\n',
      });
      expect((await runMain(['deploy'], { cwd: project.root, connect })).exitCode).toBe(0);
      const hand = await connect(sftpTarget(server), { signal: undefined });
      try {
        await hand.remove(serverPath('/home/deploy/site/old/x.txt'));
        await hand.rmdir(serverPath('/home/deploy/site/old'));
        await server.seedLink('/home/deploy/site/old', '../outside');
        const before = await server.tree('outside');
        rmSync(join(project.root, 'public_html', 'old'), { recursive: true });
        writeFileSync(join(project.root, 'public_html', 'index.html'), '<h1>version 2</h1>\n');

        const run = await runMain(['deploy'], { cwd: project.root, connect });

        expect(run.exitCode, run.stderr).toBe(0);
        expect(await server.tree('outside')).toEqual(before);
        expect((await hand.stat(serverPath('/home/deploy/site/old'))).kind).toBe('link');
        expect([...(await server.tree('site')).keys()]).toEqual(['index.html']);
      } finally {
        await hand.close();
      }
    },
  );

  // Decision 0030: the full mirror on a real server, where a delete through a link would reach
  // outside/. Files sealup never uploaded go, an excluded folder stays, and the link is left
  // alone with `allow: [symlinks]` (without it, the run stops before any change).
  it.each(['sftp', 'ssh'])(
    '%s:// mirror: true deletes what is not in the build, never an excluded path or a link',
    async (protocol) => {
      await server.clear();
      const config = (allow: string) =>
        [
          `server: ${protocol}://deploy@${server.host}:${server.port}/~/site`,
          `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `hostKey: ${server.hostKeyLine}`,
          'upload:',
          '  public_html:',
          '    to: .',
          '    mirror: true',
          'exclude:',
          '  - public_html/uploads',
          allow,
          '',
        ].join('\n');
      const hand = await connect(sftpTarget(server), { signal: undefined });
      try {
        for (const folder of ['site', 'site/old', 'site/old/a', 'site/uploads', 'outside']) {
          await hand.mkdir(serverPath(`/home/deploy/${folder}`));
        }
        for (const file of ['site/old.php', 'site/old/a/b.txt', 'site/uploads/cat.jpg']) {
          await hand.put({ bytes: Buffer.from('stray\n') }, serverPath(`/home/deploy/${file}`));
        }
        await hand.put(
          { bytes: Buffer.from('not the site\n') },
          serverPath('/home/deploy/outside/x.txt'),
        );
        await server.seedLink('/home/deploy/site/storage', '../outside');
        const files = { 'public_html/index.html': '<h1>home</h1>\n' };

        const stopped = createProject(config(''), files);
        const refused = await runMain(['deploy'], { cwd: stopped.root, connect });
        expect(refused.exitCode, refused.stderr).toBe(6);
        expect(refused.stderr).toContain('/home/deploy/site/storage is a symlink on the server');
        expect([...(await server.tree('site')).keys()].sort()).toEqual([
          'old.php',
          'old/a/b.txt',
          'uploads/cat.jpg',
        ]);

        const project = createProject(config('allow: [symlinks]'), files);
        const run = await runMain(['deploy'], { cwd: project.root, connect });

        expect(run.exitCode, run.stderr).toBe(0);
        expect([...(await server.tree('site')).keys()].sort()).toEqual([
          'index.html',
          'uploads/cat.jpg',
        ]);
        expect(await server.folders('site')).toEqual(['uploads']);
        expect([...(await server.tree('outside')).keys()]).toEqual(['x.txt']);
        expect((await hand.stat(serverPath('/home/deploy/site/storage'))).kind).toBe('link');
      } finally {
        await hand.close();
      }
    },
  );

  // Decision 0029 (R20's fixtures): the risky-folder net on a real server, whose login folder is
  // /home/deploy. With the mirror on, `/` and `/~` stop before connecting and the login folder
  // written out stops right after login (exit 6), unless `allow: [root-folder]`; without the
  // mirror a deploy into the login folder runs as before (ruling 3). Past the net, `/` gets as far
  // as the server lets it: R14 accepts the default manifest folder there (decision 0038: it is in
  // no mapping's server folder), and the container refuses `mkdir /www` (exit 5, nothing changed).
  // The manifest goes in /tmp for the other folders, as it did before 0038.
  it.each([
    ['/', true, false, 6],
    ['/', true, true, 5],
    ['/', false, false, 5],
    ['/~', true, false, 6],
    ['/~', true, true, 0],
    ['/~', false, false, 0],
    ['/home/deploy', true, false, 6],
    ['/home/deploy', true, true, 0],
    ['/home/deploy', false, false, 0],
  ])(
    'deploys into %s (mirror: %s, allow root-folder: %s): exit %i',
    async (folder, mirror, allow, exitCode) => {
      await server.clear();
      const hand = await connect(sftpTarget(server), { signal: undefined });
      try {
        for (const made of ['www', 'mail']) await hand.mkdir(serverPath(`/home/deploy/${made}`));
        await hand.put({ bytes: Buffer.from('stray\n') }, serverPath('/home/deploy/www/old.php'));
        await hand.put({ bytes: Buffer.from('mail\n') }, serverPath('/home/deploy/mail/inbox'));
      } finally {
        await hand.close();
      }
      const manifest = `/tmp/sealup-${createHash('sha256').update(`${Math.random()}`).digest('hex').slice(0, 12)}`;
      const config = [
        `server: sftp://deploy@${server.host}:${server.port}${folder}`,
        `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
        `hostKey: ${server.hostKeyLine}`,
        'upload:',
        ...(mirror
          ? ['  public_html:', '    to: www', '    mirror: true']
          : ['  public_html: www']),
        '  api: api',
        // `/` keeps the default manifest folder: one outside it does not exist.
        ...(folder === '/' ? [] : [`manifest: ${manifest}`]),
        ...(allow ? ['allow: [root-folder]'] : []),
        '',
      ].join('\n');
      const project = createProject(config, {
        'public_html/index.html': '<h1>home</h1>\n',
        'api/index.php': '<?php\n',
      });

      const run = await runMain(['deploy'], { cwd: project.root, connect });

      expect(run.exitCode, run.stderr).toBe(exitCode);
      const www = [...(await server.tree('www')).keys()].sort();
      expect([...(await server.tree('mail')).keys()]).toEqual(['inbox']);
      if (exitCode === 6) {
        expect(run.stderr).toContain('More: sealup.dev/e/risky-folder');
        expect(run.stderr.includes('before connecting')).toBe(folder !== '/home/deploy');
      }
      if (exitCode !== 0) expect(www).toEqual(['old.php']);
      else expect(www).toEqual(mirror ? ['index.html'] : ['index.html', 'old.php']);
    },
  );

  // Decision 0038 (R14, ruling 5): the owner's OVH shape from the login folder with the default
  // manifest. The bundle deploys, redeploys and deletes; the manifest lands in /~/.sealup beside
  // www/ and api/; a mapping into /~ itself still stops before connecting (exit 2).
  it('deploys the OVH shape into /~ with the default manifest in /~/.sealup (0038)', async () => {
    await server.clear();
    const hand = await connect(sftpTarget(server), { signal: undefined });
    try {
      await hand.mkdir(serverPath('/home/deploy/mail'));
      await hand.put({ bytes: Buffer.from('mail\n') }, serverPath('/home/deploy/mail/inbox'));
    } finally {
      await hand.close();
    }
    const config = (upload: readonly string[]) =>
      [
        `server: sftp://deploy@${server.host}:${server.port}/~`,
        `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
        `hostKey: ${server.hostKeyLine}`,
        'upload:',
        ...upload,
        '',
      ].join('\n');
    const project = createProject(config(['  public_html: www', '  api: api']), {
      'public_html/index.html': '<h1>home</h1>\n',
      'api/index.php': '<?php\n',
      'api/old.php': '<?php\n',
    });
    const cli = join(outdir, 'cli.mjs');

    const first = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(first.exitCode, first.stderr).toBe(0);
    rmSync(join(project.root, 'api', 'old.php'));
    const again = await runCli([cli, 'deploy'], { cwd: project.root });
    expect(again.exitCode, again.stderr).toBe(0);

    expect([...(await server.tree('www')).keys()]).toEqual(['index.html']);
    expect([...(await server.tree('api')).keys()]).toEqual(['index.php']);
    expect([...(await server.tree('mail')).keys()]).toEqual(['inbox']);
    // The manifest alone in its folder: the lock was released.
    expect([...(await server.tree('.sealup')).keys()]).toEqual([
      expect.stringMatching(/^[a-z0-9-]+\.json$/),
    ]);
    expect(await server.folders('.sealup')).toEqual([]);

    const into = createProject(config(['  public_html: .']), { 'public_html/a.txt': 'a\n' });
    const refused = await runCli([cli, 'deploy'], { cwd: into.root });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('The manifest folder is inside the target folder');
  });

  archiveContract(
    'SSH (OpenSSH container)',
    async () => {
      await server.clear();
      return {
        connect: (options = {}) =>
          connect(
            sshTarget(
              server,
              options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
            ),
            { signal: undefined },
          ),
      };
    },
    { faults: false },
  );

  // Each contract test starts from an empty login folder on the same container.
  sessionContract('SFTP (OpenSSH container)', async () => {
    await server.clear();
    return {
      seedLink: (path, target) => server.seedLink(path, target),
      connect: (options = {}) =>
        connect(
          sftpTarget(
            server,
            options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
          ),
          { signal: undefined },
        ),
    };
  });

  // The host-key scan (spec #24 decision 6) against OpenSSH: the key read inside the container.
  it('shows its host key to a scan, the one read inside the container', async () => {
    const shown = await scanHostKey(serverUrlOf(server), {
      signal: undefined,
      timeoutMs: 30_000,
      type: 'ssh-ed25519',
    });
    expect(shown).toEqual({
      type: 'ssh-ed25519',
      fingerprint: server.fingerprint,
      line: server.hostKeyLine,
    });
  });

  // ForceCommand of the sftp-server program (0039): the probe's exec opens, and an SFTP server
  // reads it. The probe ends its stdin (the server then exits 0), sees no marker and goes on
  // without the archive, well before `timeout`.
  it('offers no archive to an account whose every command runs sftp-server, at once', async () => {
    const started = Date.now();
    const session = await connect(sshTarget({ ...server, user: server.sftpOnlyUser }), {
      signal: undefined,
    });
    try {
      expect(session.archive).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await session.close();
    }
  });

  it('announces posix-rename, so a replace is one atomic rename', async () => {
    const session = await connect(sftpTarget(server), { signal: undefined });
    try {
      expect(session.caps.replace).toBe('posix-rename');
    } finally {
      await session.close();
    }
  });
});

/** A ServerPath from a literal. */
function serverPath(text: string): ServerPath {
  const parsed = parseServerPath(text);
  if (!parsed.ok) throw new Error(`fixture path ${text}: ${parsed.problem}`);
  return parsed.path;
}
