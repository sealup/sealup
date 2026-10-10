// deploy() behind the Session port (spec #41 decision 26, seam 1): the server check. With
// `checkServer: true` on a target (or `--check-server`), sealup lists the folders that hold
// tool-owned files, and a file whose size differs from the manifest's, whose server date is later
// than the manifest file's own (both on the server's clock), or that is missing is uploaded
// again, marked "changed on the server". Off by default.

import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import type { Connect, DeployEvent, Plan, ServerPath } from '../../src/contracts/index.ts';
import { deploy, type ListingLimits, listingLimits } from '../../src/deploy/index.ts';
import {
  createMemoryServer,
  createSftpServer,
  type SftpServer,
  steppedClock,
} from '../../src/testkit/index.ts';
import {
  createProject,
  eventLog,
  hostKeyLine,
  type MemorySite,
  memorySite,
  productionConfig,
  siteFiles,
} from '../deploy-kit.ts';
import { dialing, sftpTarget } from '../sftp-kit.ts';

const build = {
  'public_html/index.html': '<h1>v1</h1>',
  'public_html/main.8b1e3d07.js': 'v1',
  'public_html/admin/main.93c5b8e0.js': 'v1',
  'public_html/robots.txt': 'User-agent: *',
};

/** The page's config with `checkServer: true` on its target. */
const checking = productionConfig().replace(
  '    url: https://example.com',
  '    url: https://example.com\n    checkServer: true',
);

function planOf(events: readonly DeployEvent[]): Plan {
  const event = events.find((e) => e.type === 'plan');
  if (event?.type !== 'plan') throw new Error('no plan event');
  return event.plan;
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** A redeploy with the server check and R21's `limits`, after a first deploy of `files`. */
async function checkWith(limits: ListingLimits, files: Record<string, string> = build) {
  const project = createProject(checking, files);
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  const run = async () => {
    const loaded = await loadConfig(project.config, { PROD_PASSWORD: 'pw-for-tests' });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    return deploy(
      { config: loaded.config, target: 'production', limits },
      {
        connect: () => server.connect(),
        emit: () => undefined,
        signal: undefined,
        clock: steppedClock(0),
      },
    );
  };
  await run();
  server.seedFile('/home/site/robots.txt', 'hand edit');
  const before = server.files();
  const outcome = await run();
  return { outcome, server, before };
}

describe('the server check: R21 caps on the listing', () => {
  it('are the spec numbers by default, shared with the mirror', () => {
    expect(listingLimits).toEqual({ entries: 200_000, depth: 64 });
  });

  it('stops past the entries cap, exit 6, nothing changed', async () => {
    // Listed: the manifest folder (2 entries: the manifest and the run's lock, decision 0031),
    // the target folder (4), admin (1).
    const { outcome, server, before } = await checkWith({ entries: 6, depth: 64 });
    expect(outcome.problem).toEqual({
      code: 'listing-too-large',
      path: '/home/site/admin',
      limit: 'entries',
      max: 6,
      for: 'check-server',
      target: 'production',
    });
    expect(outcome).toMatchObject({ status: 'failed', exitCode: 6, uploaded: 0 });
    expect(server.files()).toEqual(before);
  });

  it('stops past the depth cap, exit 6, before listing anything', async () => {
    const files = { ...build, 'public_html/a/b/deep.js': 'x' };
    const { outcome, server, before } = await checkWith({ entries: 200_000, depth: 1 }, files);
    expect(outcome.problem).toMatchObject({ path: '/home/site/a/b', limit: 'depth', max: 1 });
    expect(outcome.exitCode).toBe(6);
    expect(server.files()).toEqual(before);
  });

  it('puts the file back at the caps themselves', async () => {
    const { outcome } = await checkWith({ entries: 7, depth: 1 });
    expect(outcome).toMatchObject({ exitCode: 0, uploaded: 1 });
  });
});

/** The manifest file's date on the server: the one file of the manifest folder. */
function manifestMtime(server: Pick<MemorySite['server'], 'files'>): number {
  const [manifest, ...others] = [...server.files()].filter(([path]) =>
    path.startsWith('/home/deploy/.sealup/'),
  );
  if (manifest === undefined || others.length > 0) throw new Error('not one manifest');
  return manifest[1].mtime;
}

describe('the server check puts back hand-edited files', () => {
  it('uploads again a tool-owned file whose size changed on the server', async () => {
    const s = await memorySite(build, { config: checking });
    await s.run();
    s.server.seedFile('/home/site/robots.txt', 'User-agent: *\nDisallow: /');

    const { outcome, events } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 1, unchanged: 3 });
    expect(planOf(events).ops).toEqual([
      expect.objectContaining({ op: 'upload', path: 'robots.txt', reason: 'changed-on-server' }),
    ]);
    expect(text(s.server.files().get('/home/site/robots.txt')?.bytes)).toBe('User-agent: *');
  });

  it('uploads again a file of the same size dated after the manifest', async () => {
    const s = await memorySite(build, { config: checking });
    await s.run();
    const written = manifestMtime(s.server);
    s.server.seedFile('/home/site/main.8b1e3d07.js', 'v9', { mtime: written + 1 });

    const { outcome, events } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 1, unchanged: 3 });
    expect(planOf(events).ops).toEqual([
      expect.objectContaining({ path: 'main.8b1e3d07.js', reason: 'changed-on-server' }),
    ]);
    expect(text(s.server.files().get('/home/site/main.8b1e3d07.js')?.bytes)).toBe('v1');
  });

  it('trusts a file of the same size dated with the manifest or before it', async () => {
    const s = await memorySite(build, { config: checking });
    await s.run();
    const written = manifestMtime(s.server);
    s.server.seedFile('/home/site/main.8b1e3d07.js', 'v9', { mtime: written });
    s.server.seedFile('/home/site/index.html', '<h1>v9</h1>', { mtime: written - 3600 });

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'unchanged', uploaded: 0, unchanged: 4 });
  });

  it('puts back a tool-owned file deleted by hand, and its folder', async () => {
    const s = await memorySite(build, { config: checking });
    await s.run();
    const session = await s.server.connect();
    await session.remove('/home/site/robots.txt' as ServerPath);
    await session.remove('/home/site/admin/main.93c5b8e0.js' as ServerPath);
    await session.rmdir('/home/site/admin' as ServerPath);

    const { outcome, events } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 2, unchanged: 2 });
    expect(planOf(events).ops).toEqual([
      { op: 'mkdir', path: 'admin' },
      expect.objectContaining({ path: 'admin/main.93c5b8e0.js', reason: 'changed-on-server' }),
      expect.objectContaining({ path: 'robots.txt', reason: 'changed-on-server' }),
    ]);
    expect(siteFiles(s.server)).toEqual([
      'admin/main.93c5b8e0.js',
      'index.html',
      'main.8b1e3d07.js',
      'robots.txt',
    ]);
  });

  it('checks only files the build still has: a changed or deleted one is planned as before', async () => {
    const s = await memorySite(build, { config: checking });
    await s.run();
    s.server.seedFile('/home/site/robots.txt', 'hand edit');
    s.server.seedFile('/home/site/index.html', 'hand edit');
    s.write('public_html/index.html', '<h1>v2</h1>');
    s.remove('public_html/robots.txt');

    const { events } = await s.run();

    expect(planOf(events).ops).toEqual([
      expect.objectContaining({ op: 'upload', path: 'index.html', reason: 'changed' }),
      { op: 'delete', path: 'robots.txt', reason: 'left-build' },
    ]);
  });

  it('has nothing to check on a first deploy', async () => {
    const s = await memorySite(build, { config: checking });
    s.server.seedFile('/home/site/index.html', 'there before');

    const { outcome, events } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 4 });
    expect(
      planOf(events)
        .ops.filter((op) => op.op === 'upload')
        .map((op) => op.reason),
    ).toEqual(['new', 'new', 'new', 'new']);
  });

  it('lists only the folders that hold tool-owned files, and the manifest folder', async () => {
    const s = await memorySite(build, { config: checking });
    await s.run();
    s.server.seedFile('/home/site/uploads/2024/photo.jpg', 'a user upload');
    const listed: string[] = [];
    const counting: Connect = async () => {
      const session = await s.server.connect();
      return {
        ...session,
        list: (folder, max) => {
          listed.push(folder);
          return session.list(folder, max);
        },
      };
    };

    await s.run(counting);

    expect(listed.sort()).toEqual(['/home/deploy/.sealup', '/home/site', '/home/site/admin']);
  });

  it('leaves a hand edit alone when the check is off (the default)', async () => {
    const s = await memorySite(build);
    await s.run();
    s.server.seedFile('/home/site/robots.txt', 'User-agent: *\nDisallow: /');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'unchanged', uploaded: 0, unchanged: 4 });
    expect(text(s.server.files().get('/home/site/robots.txt')?.bytes)).toBe(
      'User-agent: *\nDisallow: /',
    );
  });
});

const sftpServers: SftpServer[] = [];
afterEach(async () => {
  for (const server of sftpServers.splice(0)) await server.stop();
});

describe('the server check over SFTP', () => {
  it('puts back a file of another size, one dated after the manifest and a deleted one', async () => {
    const sftp = await createSftpServer({ loginFolder: '/home/deploy' });
    sftpServers.push(sftp);
    const project = createProject(checking.replace(hostKeyLine, sftp.hostKeyLine), build);
    const run = async () => {
      const loaded = await loadConfig(project.config, { PROD_PASSWORD: sftp.password });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      const log = eventLog();
      const outcome = await deploy(
        { config: loaded.config, target: 'production' },
        { connect: dialing(sftp), emit: log.emit, signal: undefined, clock: steppedClock(0) },
      );
      return { outcome, events: log.events };
    };
    await run();
    const written = manifestMtime(sftp);
    sftp.seedFile('/home/site/robots.txt', 'User-agent: *\nDisallow: /');
    sftp.seedFile('/home/site/main.8b1e3d07.js', 'v9', { mtime: written + 1 });
    sftp.seedFile('/home/site/index.html', '<h1>v9</h1>', { mtime: written });
    const session = await dialing(sftp)(sftpTarget(sftp), { signal: undefined });
    await session.remove('/home/site/admin/main.93c5b8e0.js' as ServerPath);
    await session.close();

    const { outcome, events } = await run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 3, unchanged: 1 });
    // The folder of a missing file is made again in case it went too (a no-op here).
    expect(planOf(events).ops.map((op) => [op.op, op.path, 'reason' in op && op.reason])).toEqual([
      ['mkdir', 'admin', false],
      ['upload', 'admin/main.93c5b8e0.js', 'changed-on-server'],
      ['upload', 'main.8b1e3d07.js', 'changed-on-server'],
      ['upload', 'robots.txt', 'changed-on-server'],
    ]);
    expect(text(sftp.files().get('/home/site/robots.txt')?.bytes)).toBe('User-agent: *');
    expect(text(sftp.files().get('/home/site/main.8b1e3d07.js')?.bytes)).toBe('v1');
    expect(text(sftp.files().get('/home/site/admin/main.93c5b8e0.js')?.bytes)).toBe('v1');
  });
});
