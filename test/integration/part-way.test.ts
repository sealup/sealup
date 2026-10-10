// deploy() behind the Session port (spec #1, seam 1): a run that stops part-way leaves a known
// state, and the same command run again finishes it (decision 0023, ticket 08). On the first
// failure no new operation starts, operations in flight finish, deletes are skipped, and the
// manifest records exactly what arrived. Ctrl-C (an AbortSignal) is a failure with status
// `cancelled` and exit 130; a stuck operation times out instead of hanging.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import type { Connect, DeployEvent, Outcome, ServerPath } from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { manifestStore } from '../../src/manifest/index.ts';
import { createMemoryServer, createSftpServer, steppedClock } from '../../src/testkit/index.ts';
import { createProject, eventLog, noWait, onlyOnce, productionConfig } from '../deploy-kit.ts';
import { dialing } from '../sftp-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

type Server = ReturnType<typeof createMemoryServer>;

interface RunOptions {
  /** Default: the site's memory server, with the target's timeout. */
  readonly connect?: Connect;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: DeployEvent) => void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A project deployed to a memory server, whose build a test can change between runs. */
function site(files: Record<string, string>, config: string = productionConfig()) {
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  const project = createProject(config, files);
  const run = async (
    options: RunOptions = {},
  ): Promise<{ outcome: Outcome; events: DeployEvent[] }> => {
    const loaded = await loadConfig(project.config, env);
    if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
    const log = eventLog();
    const outcome = await deploy(
      { config: loaded.config, target: 'production' },
      {
        connect: options.connect ?? ((target) => server.connect({ timeoutMs: target.timeoutMs })),
        emit: (event) => {
          log.emit(event);
          options.onEvent?.(event);
        },
        signal: options.signal,
        clock: steppedClock(0, 3_100),
        wait: noWait,
      },
    );
    return { outcome, events: log.events };
  };
  return {
    server,
    run,
    write(path: string, content: string) {
      const full = join(project.root, ...path.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(path: string) {
      rmSync(join(project.root, ...path.split('/')), { recursive: true });
    },
  };
}

/** The files under the target folder, relative to it. */
function siteFiles(server: Server): string[] {
  return [...server.files().keys()]
    .filter((path) => path.startsWith('/home/site/'))
    .map((path) => path.slice('/home/site/'.length))
    .sort();
}

async function manifestPaths(server: Server): Promise<string[]> {
  const session = await server.connect();
  try {
    const read = await manifestStore(session, {
      folder: `${session.loginFolder}/.sealup` as ServerPath,
      target: '/home/site' as ServerPath,
    }).read();
    if (read.kind !== 'found') throw new Error(`no manifest (${read.kind})`);
    return [...read.manifest.files.keys()];
  } finally {
    await session.close();
  }
}

/** The page's S20 build: 14 uploads (5 changed pages, 9 new bundles), 9 old bundles to delete. */
function s20Builds() {
  const first: Record<string, string> = {};
  for (let i = 0; i < 5; i++) first[`public_html/page${i}.html`] = 'v1';
  for (let i = 0; i < 9; i++) first[`public_html/old.${i}.js`] = 'old';
  first['public_html/robots.txt'] = 'User-agent: *';
  const second = (s: ReturnType<typeof site>): void => {
    for (let i = 0; i < 5; i++) s.write(`public_html/page${i}.html`, 'v2');
    for (let i = 0; i < 9; i++) {
      s.remove(`public_html/old.${i}.js`);
      s.write(`public_html/new.${i}.js`, 'new');
    }
  };
  return { first, second };
}

const uploadsOf = (events: readonly DeployEvent[]): string[] =>
  events.flatMap((event) =>
    event.type === 'plan'
      ? event.plan.ops.filter((op) => op.op === 'upload').map((op) => op.path)
      : [],
  );

describe('quota full on the Nth upload (S20)', () => {
  it('stops with exit 1, keeps the old files, and records exactly what arrived', async () => {
    const { first, second } = s20Builds();
    const s = site(first);
    await s.run();
    second(s);
    // Uploads 12, 13 and 14 of 14 are refused: the disk is full from there on. The lock's note (decision 0031) is the first put.
    const quota: Connect = async () => {
      const session = await s.server.connect();
      for (const nth of [13, 14, 15]) s.server.faults.failWrite(nth, 'quota');
      return session;
    };

    const { outcome } = await s.run({ connect: quota });

    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      uploaded: 11,
      deleted: 0,
      problem: {
        code: 'transport',
        changed: true,
        error: { code: 'quota' },
        run: { uploads: 14, arrived: 11, refused: 3, deletes: 9, deleted: 0, recorded: true },
      },
    });
    const missing = outcome.problem?.code === 'transport' ? outcome.problem.run?.missing : [];
    expect(missing?.map((file) => file.path)).toEqual(['page2.html', 'page3.html', 'page4.html']);
    expect(outcome.failed?.map((op) => op.code)).toEqual(['quota', 'quota', 'quota']);
    // Every old file is still there: deletes wait for every upload (decision 0023).
    expect(siteFiles(s.server).filter((path) => path.startsWith('old.'))).toHaveLength(9);
    // The manifest has the 11 that arrived and still the 9 old files; the 3 refused are not in it
    // as new (their old version stays recorded).
    const recorded = await manifestPaths(s.server);
    expect(recorded.filter((path) => path.startsWith('new.'))).toHaveLength(9);
    expect(recorded.filter((path) => path.startsWith('old.'))).toHaveLength(9);
  });

  it('the rerun sends only the missing files, then runs the deletes', async () => {
    const { first, second } = s20Builds();
    const s = site(first);
    await s.run();
    second(s);
    // Uploads 12, 13 and 14 are refused. The lock's note (decision 0031) is the first put.
    const quota: Connect = async () => {
      const session = await s.server.connect();
      for (const nth of [13, 14, 15]) s.server.faults.failWrite(nth, 'quota');
      return session;
    };
    await s.run({ connect: quota });

    const rerun = await s.run();

    expect(uploadsOf(rerun.events)).toEqual(['page2.html', 'page3.html', 'page4.html']);
    expect(rerun.outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 3, deleted: 9 });
    const expected = [
      ...Array.from({ length: 9 }, (_, i) => `new.${i}.js`),
      ...Array.from({ length: 5 }, (_, i) => `page${i}.html`),
      'robots.txt',
    ];
    expect(siteFiles(s.server)).toEqual(expected);
    expect((await manifestPaths(s.server)).sort()).toEqual(expected);
  });
});

describe('the manifest after a run that changed something', () => {
  it('counts a delete of a file already gone from the server as done', async () => {
    const s = site({ 'public_html/a.html': 'a', 'public_html/b.html': 'b' });
    await s.run();
    // Someone removed b.html on the server; it also left the build.
    const session = await s.server.connect();
    await session.remove('/home/site/b.html' as ServerPath);
    s.remove('public_html/b.html');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, deleted: 1 });
    expect(await manifestPaths(s.server)).toEqual(['a.html']);
  });
});

describe('a stuck operation (timeout)', () => {
  it('fails the run after `timeout` instead of hanging, and the rerun finishes it', async () => {
    const server = await createSftpServer({ password: env.PROD_PASSWORD });
    cleanups.push(() => server.stop());
    const s = site(
      {
        'public_html/a.html': 'a',
        'public_html/b.html': 'b',
        'public_html/c.html': 'c',
      },
      `timeout: 1s\n${productionConfig().replace(/hostKey: .*/, `hostKey: ${server.hostKeyLine}`)}`,
    );
    const overSftp = { connect: dialing(server) };
    // The second upload's OPEN is never answered. The lock's note (decision 0031) is the first put.
    // The server is not reached again: the reconnect's tries (spec #41 decision 20) fail.
    server.faults.failWrite(3, 'timeout');

    const started = performance.now();
    const { outcome } = await s.run({ connect: onlyOnce(dialing(server)) });

    expect(performance.now() - started).toBeLessThan(4_000);
    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      uploaded: 2,
      problem: {
        code: 'transport',
        changed: true,
        error: { code: 'timeout' },
        run: { uploads: 3, arrived: 2, refused: 1, recorded: true },
      },
      failed: [{ path: 'b.html', code: 'timeout' }],
    });
    // The session stayed open after the timeout: the manifest was written, so the rerun sends
    // only the file that did not arrive.
    const rerun = await s.run(overSftp);
    expect(uploadsOf(rerun.events)).toEqual(['b.html']);
    expect(rerun.outcome).toMatchObject({ status: 'ok', exitCode: 0 });
  });
});

describe('connection lost after the first change', () => {
  it('exits 1 (not 5), with the state: what arrived, and that nothing could be recorded', async () => {
    const s = site({
      'public_html/a.html': 'a',
      'public_html/b.html': 'b',
      'public_html/c.html': 'c',
    });
    // The second upload. The lock's note (decision 0031) is the first put. The connection does
    // not come back: the reconnect's tries (spec #41 decision 20) fail.
    s.server.faults.failWrite(3, 'connection-lost');

    const { outcome } = await s.run({ connect: onlyOnce(() => s.server.connect()) });

    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      problem: {
        code: 'transport',
        changed: true,
        error: { code: 'connection-lost' },
        run: { uploads: 3, recorded: false },
      },
    });
  });
});

describe('a failure before any real change (operations that found their work done count for nothing)', () => {
  /** Deployed once, then one page changed: the rerun's folders exist, nothing is deleted. */
  async function redeployed() {
    const s = site({ 'public_html/a.html': 'a', 'public_html/sub/b.html': 'b' });
    await s.run();
    s.write('public_html/a.html', 'a2');
    return s;
  }

  it('a connection lost on the first upload exits 5: nothing was changed', async () => {
    const s = await redeployed();
    const before = s.server.files();
    // The first upload. The lock's note (decision 0031) is the first put. The connection does not
    // come back: the reconnect's tries (spec #41 decision 20) fail.
    s.server.faults.failWrite(2, 'connection-lost');

    const { outcome } = await s.run({ connect: onlyOnce(() => s.server.connect()) });

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 5,
      problem: { code: 'transport', changed: false, error: { code: 'connection-lost' } },
    });
    // The lock stays, its connection gone (decision 0031): the next run takes it over.
    const [lockNote, ...more] = [...s.server.files().keys()].filter((path) =>
      path.includes('.json.lock/'),
    );
    expect(lockNote).toMatch(/\.json\.lock\/note\.json$/);
    expect(more).toEqual([]);
    const after = new Map(s.server.files());
    after.delete(lockNote ?? '');
    expect(after).toEqual(before);
  });

  it('an error not expected on the first upload exits 1, and says nothing was changed', async () => {
    const s = await redeployed();
    const failing: Connect = async () => {
      const session = await s.server.connect();
      return {
        ...session,
        // Every upload; the lock's note (decision 0031) goes to the manifest folder.
        put: async (source, to, options) => {
          if (to.startsWith('/home/site/')) throw new Error('ENOENT: no such file');
          await session.put(source, to, options);
        },
      };
    };

    const { outcome } = await s.run({ connect: failing });

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 1,
      problem: { code: 'unexpected', changed: false },
    });
  });
});

describe('an error sealup did not expect, part-way', () => {
  it('still records what arrived (exit 1), so the rerun sends only the rest', async () => {
    const s = site(
      { 'public_html/a.html': 'a', 'public_html/b.html': 'b', 'public_html/c.html': 'c' },
      `parallel: 1\n${productionConfig()}`,
    );
    // The second file cannot be read any more (it vanished between scan and upload, say).
    const vanishing: Connect = async () => {
      const session = await s.server.connect();
      let puts = 0;
      return {
        ...session,
        put: async (source, to) => {
          // The second upload. The lock's note (decision 0031) is the first put.
          if (++puts === 3) throw new Error('ENOENT: no such file');
          await session.put(source, to);
        },
      };
    };

    const { outcome } = await s.run({ connect: vanishing });

    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      uploaded: 1,
      problem: { code: 'unexpected', changed: true, run: { arrived: 1, recorded: true } },
    });
    expect(await manifestPaths(s.server)).toEqual(['a.html']);
    const rerun = await s.run();
    expect(uploadsOf(rerun.events)).toEqual(['b.html', 'c.html']);
  });
});

describe('Ctrl-C (the AbortSignal)', () => {
  it('starts no new transfer, records what arrived, and exits 130', async () => {
    const s = site(
      { 'public_html/a.html': 'a', 'public_html/b.html': 'b', 'public_html/c.html': 'c' },
      `parallel: 1\n${productionConfig()}`,
    );
    const controller = new AbortController();

    const { outcome } = await s.run({
      signal: controller.signal,
      // Ctrl-C as the first file arrives.
      onEvent: (event) => {
        if (event.type === 'progress') controller.abort();
      },
    });

    expect(outcome).toMatchObject({
      status: 'cancelled',
      exitCode: 130,
      uploaded: 1,
      problem: {
        code: 'interrupted',
        changed: true,
        run: { uploads: 3, arrived: 1, refused: 0, recorded: true },
      },
    });
    expect(siteFiles(s.server)).toEqual(['a.html']);
    expect(await manifestPaths(s.server)).toEqual(['a.html']);
    const rerun = await s.run();
    expect(uploadsOf(rerun.events)).toEqual(['b.html', 'c.html']);
  });

  it('before connecting: exits 130, never connects, nothing changed', async () => {
    const s = site({ 'public_html/a.html': 'a' });
    const controller = new AbortController();
    controller.abort();
    let connected = false;

    const { outcome } = await s.run({
      signal: controller.signal,
      connect: async () => {
        connected = true;
        return s.server.connect();
      },
    });

    expect(connected).toBe(false);
    expect(outcome).toMatchObject({
      status: 'cancelled',
      exitCode: 130,
      problem: { code: 'interrupted', changed: false },
    });
    expect(siteFiles(s.server)).toEqual([]);
  });
});
