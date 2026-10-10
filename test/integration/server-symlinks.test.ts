// R16 on the server (spec #41 decision 27, seam 1): before the first write into a folder this run
// did not make, each folder of the path is looked at once (Session.stat, lstat); a link stops the
// run before any change, exit 6 `symlink`, naming the server path. The real danger, a server that
// follows the link, is shown against the OpenSSH container (test/e2e/openssh.test.ts).

import { describe, expect, it } from 'vitest';
import type { Connect, RemotePath, ServerPath, Session } from '../../src/contracts/index.ts';
import { manifestStore } from '../../src/manifest/index.ts';
import { parseServerPath } from '../../src/paths/index.ts';
import { createMemoryServer, goldenText } from '../../src/testkit/index.ts';
import { createProject, memorySite, productionConfig, runMain } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

/** A memory server holding `/home/site/api → ../outside`, and `/home/outside` with one file. */
function plantedServer() {
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  server.seedFile('/home/site/index.html', 'old home');
  server.seedFile('/home/outside/keep.txt', 'not the site');
  server.seedLink('/home/site/api', '../outside');
  return server;
}

/** Everything the server holds, files with their bytes and folders: to compare before and after. */
function snapshot(server: ReturnType<typeof createMemoryServer>) {
  const files = [...server.files()].map(([path, file]) => [path, file.sha256, file.mode]);
  return { files, folders: server.folders() };
}

/** The last lines of a run's stderr: its problem block, without the target block above it. */
function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .slice(-count - 1)
    .join('\n');
}

describe('R16 on the server: a link in a folder the run writes into', () => {
  it('site/api → ../outside: the run stops before any change, exit 6, naming the link', async () => {
    const server = plantedServer();
    const before = snapshot(server);
    const project = createProject(productionConfig(), {
      'public_html/index.html': 'new home',
      'public_html/api/index.php': '<?php echo 1;',
    });

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(6);
    expect(lastLines(run.stderr, 6)).toBe(
      goldenText(
        [
          '  {rb}✗{/} {b}/home/site/api is a symlink on the server: sealup stopped.{/}',
          '    sealup never writes through a link: files could land outside the target.',
          '    Replace the link with a real folder, or exclude what goes into it.',
          '',
          '    Nothing was changed on production.',
          '    {d}More: sealup.dev/e/symlink{/}',
        ],
        { color: false },
      ),
    );
    // Nothing changed: not outside/, not the site, no manifest. The lock (decision 0031) was taken
    // and released before the link check; the manifest folder its mkdir made went with it.
    expect(snapshot(server)).toEqual(before);
  });

  it('a manifest folder several levels deep: every folder the lock made goes with it', async () => {
    const server = plantedServer();
    server.seedFile('/home/deploy/state/keep.txt', 'was there');
    const before = snapshot(server);
    const config = productionConfig().replace(
      '    url: https://example.com',
      '    url: https://example.com\n    manifest: state/sealup/deploys',
    );
    const project = createProject(config, { 'public_html/api/index.php': '<?php echo 1;' });

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain('Nothing was changed on production.');
    expect(snapshot(server)).toEqual(before);
  });

  it('says blocked in --json, and a dry run stops on it too', async () => {
    const server = plantedServer();
    const project = createProject(productionConfig(), { 'public_html/api/a.php': 'x' });

    const json = await runMain(['deploy', 'production', '--json'], {
      cwd: project.root,
      env,
      server,
    });
    const dry = await runMain(['deploy', 'production', '-n'], { cwd: project.root, env, server });

    expect(json.exitCode).toBe(6);
    expect(JSON.parse(json.stdout)).toMatchObject({
      status: 'blocked',
      error: { code: 'symlink', message: expect.stringContaining('/home/site/api') },
    });
    expect(dry.exitCode).toBe(6);
    expect(dry.stderr).toContain('/home/site/api is a symlink on the server');
  });

  it('a delete never goes through a link: a recorded folder turned into one stops the run', async () => {
    const site = await memorySite({
      'public_html/index.html': 'home',
      'public_html/old/a/x.txt': 'old',
    });
    expect((await site.run()).outcome.exitCode).toBe(0);
    // Someone replaces old/ by a link to a folder outside; the build drops old/.
    const hand = await site.server.connect();
    await hand.remove(at('/home/site/old/a/x.txt'));
    await hand.rmdir(at('/home/site/old/a'));
    await hand.rmdir(at('/home/site/old'));
    await hand.close();
    site.server.seedFile('/home/outside/a/x.txt', 'not the site');
    site.server.seedLink('/home/site/old', '../outside');
    site.remove('public_html/old');
    const before = snapshot(site.server);

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({
      exitCode: 6,
      status: 'failed',
      problem: { code: 'symlink', on: 'server', path: '/home/site/old', target: 'production' },
    });
    expect(snapshot(site.server)).toEqual(before);
  });

  it("the last run's temp names are not removed through a link either (R18)", async () => {
    const site = await memorySite({ 'public_html/index.html': 'home' });
    expect((await site.run()).outcome.exitCode).toBe(0);
    // A killed run left a temp name in sub/, which is now a link; nothing else to do.
    const store = manifestStore(await site.server.connect(), {
      folder: at('/home/deploy/.sealup'),
      target: at('/home/site'),
    });
    const read = await store.read();
    if (read.kind !== 'found') throw new Error('no manifest');
    const temp = 'sub/.a.html.sealup-0123456789abcdef.tmp' as RemotePath;
    await store.write({ ...read.manifest, pending: [temp] });
    site.server.seedFile(`/home/outside/${temp.slice(4)}`, 'not the site');
    site.server.seedLink('/home/site/sub', '../outside');
    const before = snapshot(site.server);

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'symlink', on: 'server', path: '/home/site/sub' },
    });
    expect(snapshot(site.server)).toEqual(before);
  });
});

describe('R16 on the server: each folder is looked at once per run', () => {
  /** A connect that counts the paths stat() is asked about. */
  function counting(server: { connect(): Promise<Session> }) {
    const asked: ServerPath[] = [];
    const connect: Connect = async () => {
      const session = await server.connect();
      return {
        ...session,
        stat: (path) => {
          asked.push(path);
          return session.stat(path);
        },
      };
    };
    return { asked, connect };
  }

  const build = {
    'public_html/a/b/c/1.txt': '1',
    'public_html/a/b/c/2.txt': '2',
    'public_html/a/3.txt': '3',
    'public_html/d/4.txt': '4',
    'public_html/top.txt': 'top',
  };

  it('a folder found missing is made by this run: nothing below it is looked at', async () => {
    const site = await memorySite(build);
    const { asked, connect } = counting(site.server);

    expect((await site.run(connect)).outcome.exitCode).toBe(0);

    expect(asked.sort()).toEqual(['/home/site/a', '/home/site/d']);
  });

  it('a redeploy looks at each folder it writes into once, however many files go there', async () => {
    const site = await memorySite(build);
    expect((await site.run()).outcome.exitCode).toBe(0);
    for (const [path, content] of Object.entries(build)) site.write(path, `${content} changed`);
    const { asked, connect } = counting(site.server);

    expect((await site.run(connect)).outcome.exitCode).toBe(0);

    expect(asked.sort()).toEqual([
      '/home/site/a',
      '/home/site/a/b',
      '/home/site/a/b/c',
      '/home/site/d',
    ]);
  });

  it('a redeploy with nothing to do looks at nothing', async () => {
    const site = await memorySite(build);
    expect((await site.run()).outcome.exitCode).toBe(0);
    const { asked, connect } = counting(site.server);

    expect((await site.run(connect)).outcome.status).toBe('unchanged');

    expect(asked).toEqual([]);
  });

  it('a link outside the folders written into is left alone (allow: [symlinks] is T10)', async () => {
    const site = await memorySite({ 'public_html/index.html': 'home' });
    expect((await site.run()).outcome.exitCode).toBe(0);
    site.server.seedLink('/home/site/storage', '../storage/app/public');
    site.write('public_html/index.html', 'new home');

    const { outcome } = await site.run();

    expect(outcome.exitCode).toBe(0);
    expect(site.server.files().get('/home/site/index.html')?.size).toBe('new home'.length);
  });
});

/** A ServerPath from a literal. */
function at(text: string): ServerPath {
  const parsed = parseServerPath(text);
  if (!parsed.ok) throw new Error(`fixture path ${text}: ${parsed.problem}`);
  return parsed.path;
}
