// `allow: [symlinks]` (spec #41 decision 28, seam 1): a Laravel developer's `storage` link is left
// alone instead of stopping the run. Links in a source folder are skipped, never followed, and
// listed as skipped; server links inside the target folder are never deleted; a write through a
// server link is still refused (R16 holds whatever `allow:` says). Without the allow, the stops of
// cli-safety-nets.test.ts and server-symlinks.test.ts are unchanged.

import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemotePath, ServerPath } from '../../src/contracts/index.ts';
import { manifestStore } from '../../src/manifest/index.ts';
import { parseServerPath } from '../../src/paths/index.ts';
import { createMemoryServer, goldenText, screenOf } from '../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  type MemorySite,
  memorySite,
  productionConfig,
  runMain,
  siteFiles,
} from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
/** The fixture's target with the allow. */
const allowing = `${productionConfig()}    allow: [symlinks]\n`;

/**
 * A Laravel-like build: `public_html/storage → ../storage/app/public` (a junction on Windows, so
 * no admin right is needed), with a file behind it that must never be sent.
 */
function laravel(config = allowing) {
  const project = createProject(config, {
    'public_html/index.php': '<?php echo 1;',
    'storage/app/public/avatar.jpg': 'not to send',
  });
  symlinkSync(
    join(project.root, 'storage', 'app', 'public'),
    join(project.root, 'public_html', 'storage'),
    'junction',
  );
  return project;
}

describe('allow: [symlinks], links in a source folder', () => {
  it('skips the link, never follows it, and deploys the rest (exit 0)', async () => {
    const project = laravel();
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(0);
    expect(siteFiles(server)).toEqual(['index.php']);
  });

  it('lists the link as skipped in the dry run, under what would change', async () => {
    const project = laravel();
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const run = await runMain(['deploy', '--dry-run', 'production'], {
      cwd: project.root,
      env,
      server,
      tty: true,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      goldenText(
        [
          '  {b}Would skip 1 link in your build{/}  {d}(sealup never follows a link){/}',
          '    · public_html/storage',
          '',
        ],
        { color: true },
      ),
    );
    expect(siteFiles(server)).toEqual([]);
  });

  it('lists it under the plan line of a real run, on a terminal and in the CI log', async () => {
    const project = laravel();
    const skipped = [
      '  {b}Skipped 1 link in your build{/}  {d}(sealup never follows a link){/}',
      '    · public_html/storage',
      '',
      '  {gb}✓ Sealed up and delivered:{/} 1 file to production in ',
    ];
    const at = { cwd: project.root, env };

    const terminal = await runMain(['deploy', 'production'], {
      ...at,
      server: createMemoryServer({ loginFolder: '/home/deploy' }),
      tty: true,
    });
    const log = await runMain(['deploy', 'production'], {
      ...at,
      server: createMemoryServer({ loginFolder: '/home/deploy' }),
    });

    expect(screenOf(terminal.stderr)).toContain(goldenText(skipped, { color: true }).slice(0, -1));
    expect(log.stderr).toContain(goldenText(skipped, { color: false }).slice(0, -1));
  });

  it('lists it in the job summary, of a real run and of a dry run', async () => {
    const project = laravel();
    const block = [
      '<details><summary>Skipped 1 link in your build (sealup never follows a link)</summary>',
      '',
      '```',
      'public_html/storage',
      '```',
      '',
      '</details>',
    ].join('\n');
    const at = { cwd: project.root, env: { ...env, ...inGitHub } };

    const dry = await runMain(['deploy', '--dry-run', 'production'], {
      ...at,
      server: createMemoryServer({ loginFolder: '/home/deploy' }),
    });
    const real = await runMain(['deploy', 'production'], {
      ...at,
      server: createMemoryServer({ loginFolder: '/home/deploy' }),
    });

    expect(dry.summary).toContain(block);
    expect(real.summary).toContain(block);
    expect(real.exitCode).toBe(0);
  });

  it('without the allow, the same build still stops before connecting (exit 6)', async () => {
    const project = laravel(productionConfig());

    // No server: a run that connects fails the test.
    const run = await runMain(['deploy', 'production'], { cwd: project.root, env });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toContain('public_html/storage is a symlink: sealup stopped before');
  });
});

describe('allow: [symlinks], links on the server', () => {
  /** What `path` is on the server now: a link stays a link. */
  async function kindOn(site: MemorySite, path: string) {
    const session = await site.server.connect();
    try {
      return (await session.stat(at(path))).kind;
    } finally {
      await session.close();
    }
  }

  /** Everything the server holds, files with their bytes and folders: to compare before and after. */
  function snapshot(site: MemorySite) {
    const files = [...site.server.files()].map(([path, file]) => [path, file.sha256]);
    return { files, folders: site.server.folders() };
  }

  it("the Laravel storage link on the server is left alone while the site's files change", async () => {
    const site = await memorySite({ 'public_html/index.php': 'v1' }, { config: allowing });
    expect((await site.run()).outcome.exitCode).toBe(0);
    site.server.seedFile('/home/storage/app/public/avatar.jpg', 'a user upload');
    site.server.seedLink('/home/site/storage', '../storage/app/public');
    site.write('public_html/index.php', 'v2');

    const { outcome } = await site.run();

    expect(outcome.exitCode).toBe(0);
    expect(await kindOn(site, '/home/site/storage')).toBe('link');
    expect(site.server.files().get('/home/storage/app/public/avatar.jpg')?.size).toBe(13);
  });

  it('R16 holds whatever allow: says: a write through a server link still stops, exit 6', async () => {
    const site = await memorySite(
      { 'public_html/index.html': 'home', 'public_html/api/index.php': '<?php' },
      { config: allowing },
    );
    site.server.seedFile('/home/outside/keep.txt', 'not the site');
    site.server.seedLink('/home/site/api', '../outside');
    const before = snapshot(site);

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'symlink', on: 'server', path: '/home/site/api' },
    });
    // Nothing changed: the manifest folder the lock's mkdir made went with the lock.
    expect(snapshot(site)).toEqual(before);
  });

  it('a recorded folder turned into a link: its files are kept, the link and what it points to stay', async () => {
    const site = await memorySite(
      { 'public_html/index.html': 'home', 'public_html/old/a/x.txt': 'old' },
      { config: allowing },
    );
    expect((await site.run()).outcome.exitCode).toBe(0);
    await replaceByLink(site, '/home/site/old', ['a/x.txt'], ['a']);
    site.remove('public_html/old');
    site.write('public_html/index.html', 'new home');
    const dry = await site.run(undefined, true);

    const { outcome } = await site.run();

    expect(dry.events).toContainEqual({
      type: 'plan',
      plan: expect.objectContaining({ kept: [{ path: 'old/a/x.txt', reason: 'link' }] }),
    });
    expect(outcome).toMatchObject({ exitCode: 0, uploaded: 1, deleted: 0 });
    expect(await kindOn(site, '/home/site/old')).toBe('link');
    expect(site.server.files().get('/home/outside/a/x.txt')?.size).toBe('not the site'.length);
  });

  it('a recorded file that is now a link on the server is never deleted', async () => {
    const site = await memorySite(
      { 'public_html/index.html': 'home', 'public_html/config.php': 'v1' },
      { config: allowing },
    );
    expect((await site.run()).outcome.exitCode).toBe(0);
    await replaceByLink(site, '/home/site/config.php', [], []);
    site.remove('public_html/config.php');
    const dry = await runMain(['deploy', '--dry-run', 'production'], {
      cwd: site.root,
      env,
      server: site.server,
    });

    const { outcome, events } = await site.run();

    expect(dry.stderr).toContain(
      goldenText(
        [
          '  Would keep 1 file',
          '    · config.php  a link on the server, never deleted',
          '  1 unchanged',
        ],
        { color: false },
      ),
    );

    expect(outcome).toMatchObject({ exitCode: 0, deleted: 0 });
    expect(events).toContainEqual({
      type: 'plan',
      plan: expect.objectContaining({ kept: [{ path: 'config.php', reason: 'link' }] }),
    });
    expect(await kindOn(site, '/home/site/config.php')).toBe('link');
  });

  it('a recorded file now a link where the build needs a folder: the write through it stops', async () => {
    const site = await memorySite(
      { 'public_html/index.html': 'home', 'public_html/data': 'a file' },
      { config: allowing },
    );
    expect((await site.run()).outcome.exitCode).toBe(0);
    await replaceByLink(site, '/home/site/data', [], []);
    site.remove('public_html/data');
    site.write('public_html/data/x.txt', 'now a folder');
    const before = snapshot(site);

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'symlink', on: 'server', path: '/home/site/data' },
    });
    expect(snapshot(site)).toEqual(before);
    expect(await kindOn(site, '/home/site/data')).toBe('link');
  });

  it('a recorded folder now a link where the build needs a file: it is never replaced', async () => {
    const site = await memorySite(
      { 'public_html/index.html': 'home', 'public_html/data/x.txt': 'in a folder' },
      { config: allowing },
    );
    expect((await site.run()).outcome.exitCode).toBe(0);
    await replaceByLink(site, '/home/site/data', ['x.txt'], []);
    site.remove('public_html/data');
    site.write('public_html/data', 'now a file');
    const before = snapshot(site);

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'symlink', on: 'server', path: '/home/site/data' },
    });
    expect(snapshot(site)).toEqual(before);
    expect(await kindOn(site, '/home/site/data')).toBe('link');
  });

  it("the last run's temp names behind a link are left alone, and the run goes on", async () => {
    const site = await memorySite({ 'public_html/index.html': 'home' }, { config: allowing });
    expect((await site.run()).outcome.exitCode).toBe(0);
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
    site.write('public_html/index.html', 'new home');

    const { outcome } = await site.run();

    expect(outcome.exitCode).toBe(0);
    expect(site.server.files().has(`/home/outside/${temp.slice(4)}`)).toBe(true);
    expect(await kindOn(site, '/home/site/sub')).toBe('link');
  });
});

/**
 * Someone replaces `path` (a file, or a folder holding `files` in `folders`) by a link to
 * `/home/outside`, which holds files of the same names that are not the site's.
 */
async function replaceByLink(
  site: MemorySite,
  path: string,
  files: readonly string[],
  folders: readonly string[],
): Promise<void> {
  const hand = await site.server.connect();
  if (files.length === 0 && folders.length === 0) await hand.remove(at(path));
  for (const file of files) await hand.remove(at(`${path}/${file}`));
  for (const folder of [...folders].reverse()) await hand.rmdir(at(`${path}/${folder}`));
  if (folders.length > 0) await hand.rmdir(at(path));
  await hand.close();
  for (const file of files) site.server.seedFile(`/home/outside/${file}`, 'not the site');
  site.server.seedLink(path, '../outside');
}

/** A ServerPath from a literal. */
function at(text: string): ServerPath {
  const parsed = parseServerPath(text);
  if (!parsed.ok) throw new Error(`fixture path ${text}: ${parsed.problem}`);
  return parsed.path;
}
