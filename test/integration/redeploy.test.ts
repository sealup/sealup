// deploy() behind the Session port (spec #1, seam 1): the daily run. The manifest read back, only
// changed files sent, deletes of files sealup uploaded once every upload is in (decisions 0008,
// 0023; R13), emptied folders removed, excludes never sent and never deleted.

// A file that becomes a folder, or a folder a file (S1), is in redeploy-swap.test.ts.

import { describe, expect, it } from 'vitest';
import type { Connect } from '../../src/contracts/index.ts';
import { manifestPaths, memorySite, productionConfig, siteFiles } from '../deploy-kit.ts';

const build = {
  'public_html/index.html': '<h1>v1</h1>',
  'public_html/main.8b1e3d07.js': 'v1',
  'public_html/admin/main.93c5b8e0.js': 'v1',
  'public_html/robots.txt': 'User-agent: *',
};

describe('redeploy: only what changed travels', () => {
  it('sends new and changed files, deletes what left the build, and records it', async () => {
    const s = await memorySite(build);
    await s.run();
    s.write('public_html/index.html', '<h1>v2</h1>');
    s.remove('public_html/main.8b1e3d07.js');
    s.write('public_html/main.4f2a9c1e.js', 'v2');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({
      status: 'ok',
      exitCode: 0,
      uploaded: 2,
      deleted: 1,
      unchanged: 2,
      bytes: 11 + 2,
    });
    const now = ['admin/main.93c5b8e0.js', 'index.html', 'main.4f2a9c1e.js', 'robots.txt'];
    expect(siteFiles(s.server)).toEqual(now);
    expect(await manifestPaths(s.server)).toEqual(now);
    expect(new TextDecoder().decode(s.server.files().get('/home/site/index.html')?.bytes)).toBe(
      '<h1>v2</h1>',
    );
  });

  it('says nothing changed, writes nothing and exits 0 when the build is the same', async () => {
    const s = await memorySite(build);
    await s.run();
    const before = s.server.files();

    const { outcome, events } = await s.run();

    expect(outcome).toMatchObject({
      status: 'unchanged',
      exitCode: 0,
      uploaded: 0,
      deleted: 0,
      unchanged: 4,
      bytes: 0,
    });
    expect(s.server.files()).toEqual(before);
    expect(events.map((event) => event.type)).toEqual(['start', 'host-key', 'plan', 'done']);
  });

  it('never deletes on a first deploy: files already on the server stay (decision 0008)', async () => {
    const s = await memorySite(build);
    s.server.seedFile('/home/site/old-site.html', 'by hand');
    const { outcome } = await s.run();
    expect(outcome).toMatchObject({ status: 'ok', deleted: 0 });
    expect(siteFiles(s.server)).toContain('old-site.html');
  });

  it('never deletes a file sealup did not upload', async () => {
    const s = await memorySite(build);
    await s.run();
    s.server.seedFile('/home/site/uploads/user.jpg', 'written by the site');
    s.remove('public_html/robots.txt');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ deleted: 1 });
    expect(siteFiles(s.server)).toContain('uploads/user.jpg');
    expect(siteFiles(s.server)).not.toContain('robots.txt');
  });
});

describe('redeploy: folders', () => {
  it('removes the folders emptied by deletes, and leaves a folder that still holds a file', async () => {
    const s = await memorySite({
      ...build,
      'public_html/old/a/b.js': 'v1',
      'public_html/shared/c.js': 'v1',
    });
    await s.run();
    s.server.seedFile('/home/site/shared/by-hand.txt', 'kept');
    s.remove('public_html/old');
    s.remove('public_html/shared');
    s.remove('public_html/admin');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, deleted: 3 });
    const folders = s.server.folders().filter((path) => path.startsWith('/home/site'));
    expect(folders).toEqual(['/home/site', '/home/site/shared']);
    expect(siteFiles(s.server)).toContain('shared/by-hand.txt');
  });
});

describe('redeploy: excludes (R13)', () => {
  const config = (exclude: string): string =>
    productionConfig().replace('targets:', `exclude: [${exclude}]\ntargets:`);

  it('never sends an excluded file', async () => {
    const s = await memorySite(
      { ...build, 'public_html/resources/cat.jpg': 'local copy' },
      { config: config('public_html/resources') },
    );
    await s.run();
    expect(siteFiles(s.server).some((path) => path.startsWith('resources/'))).toBe(false);
  });

  it('never deletes an excluded file, even one the manifest records', async () => {
    const s = await memorySite(build);
    await s.run();
    s.setConfig(config('public_html/robots.txt'));
    s.remove('public_html/robots.txt');

    const { outcome, events } = await s.run();

    expect(outcome).toMatchObject({ status: 'unchanged', deleted: 0 });
    expect(siteFiles(s.server)).toContain('robots.txt');
    const plan = events.find((event) => event.type === 'plan');
    expect(plan).toMatchObject({ plan: { kept: [{ path: 'robots.txt', reason: 'excluded' }] } });
  });

  it('checks a manifest path through its mapping: excludes are written on the local side', async () => {
    const yaml = productionConfig().replace(
      'upload: public_html',
      'upload:\n  public_html: www\nexclude: [public_html/resources]',
    );
    const s = await memorySite(
      { 'public_html/index.html': 'x', 'public_html/resources/a.jpg': 'y' },
      { config: productionConfig().replace('upload: public_html', 'upload:\n  public_html: www') },
    );
    await s.run();
    s.setConfig(yaml);
    s.remove('public_html/resources');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ deleted: 0 });
    expect(siteFiles(s.server)).toEqual(['www/index.html', 'www/resources/a.jpg']);
  });
});

describe('redeploy: deletes wait for every upload (decision 0023)', () => {
  it('keeps the old files when an upload fails, and records only what arrived', async () => {
    const s = await memorySite(build);
    await s.run();
    s.write('public_html/index.html', '<h1>v2</h1>');
    s.write('public_html/main.4f2a9c1e.js', 'v2');
    s.remove('public_html/main.8b1e3d07.js');
    const failing: Connect = async () => {
      const session = await s.server.connect();
      // The second upload: the lock's note (decision 0031) is the first put.
      s.server.faults.failWrite(3, 'quota');
      return session;
    };

    const { outcome } = await s.run(failing);

    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      deleted: 0,
      problem: { code: 'transport', changed: true, error: { code: 'quota' } },
    });
    expect(siteFiles(s.server)).toContain('main.8b1e3d07.js');
    expect(await manifestPaths(s.server)).toContain('main.8b1e3d07.js');

    // The rerun sends the rest, then deletes.
    const rerun = await s.run();
    expect(rerun.outcome).toMatchObject({ status: 'ok', deleted: 1 });
    expect(siteFiles(s.server)).not.toContain('main.8b1e3d07.js');
    expect(await manifestPaths(s.server)).toEqual(siteFiles(s.server));
  });
});

describe('redeploy: progress', () => {
  it('tells how many files and bytes have arrived, after each upload', async () => {
    const s = await memorySite(build);
    const { events } = await s.run();
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress).toHaveLength(4);
    expect(progress.at(-1)).toMatchObject({
      type: 'progress',
      files: 4,
      totalFiles: 4,
      bytes: 11 + 2 + 2 + 13,
      totalBytes: 11 + 2 + 2 + 13,
    });
    const types = events.map((event) => event.type);
    expect(types.indexOf('plan')).toBeLessThan(types.indexOf('progress'));
    expect(types.at(-1)).toBe('done');
  });
});
