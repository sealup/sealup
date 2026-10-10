// deploy() behind the Session port (spec #1, seam 1), when a file becomes a folder or a folder a
// file (S1): what stands in the way is removed right before, a run stopped at any change is
// finished by the rerun, and what sealup did not upload stops it. Split from redeploy.test.ts so
// Vitest runs the two files side by side.

import { describe, expect, it } from 'vitest';
import { type Connect, TransportError } from '../../src/contracts/index.ts';
import type { createMemoryServer } from '../../src/testkit/index.ts';
import {
  type MemorySite,
  manifestPaths,
  memorySite,
  onlyOnce,
  productionConfig,
  siteFiles,
} from '../deploy-kit.ts';

type Server = ReturnType<typeof createMemoryServer>;

describe('a file becomes a folder, or a folder a file (S1)', () => {
  /** A connect whose session fails its nth change (mkdir, put, rename, remove, rmdir). */
  const failingAt =
    (server: Server, nth: number, code: 'permission' | 'connection-lost'): Connect =>
    async () => {
      const session = await server.connect();
      let calls = 0;
      const counted =
        <A extends unknown[], R>(op: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          if (++calls === nth) {
            if (code === 'connection-lost') await session.close();
            throw new TransportError(code, code === 'connection-lost' ? 'lost' : 'answer');
          }
          return op(...args);
        };
      return {
        ...session,
        put: counted(session.put),
        rename: counted(session.rename),
        remove: counted(session.remove),
        mkdir: counted(session.mkdir),
        rmdir: counted(session.rmdir),
      };
    };

  type Site = MemorySite;
  const scenarios = [
    {
      name: 'a file becomes a folder',
      first: {
        'public_html/index.html': 'i',
        'public_html/docs': 'a file',
        'public_html/old.js': 'o',
      },
      change: (s: Site) => {
        s.remove('public_html/docs');
        s.remove('public_html/old.js');
        s.write('public_html/docs/a.html', 'a');
        s.write('public_html/docs/img/b.png', 'b');
      },
      expected: ['docs/a.html', 'docs/img/b.png', 'index.html'],
    },
    {
      name: 'a folder becomes a file',
      first: {
        'public_html/index.html': 'i',
        'public_html/docs/a.html': 'a',
        'public_html/docs/img/b.png': 'b',
      },
      change: (s: Site) => {
        s.remove('public_html/docs');
        s.write('public_html/docs', 'a file');
      },
      expected: ['docs', 'index.html'],
    },
  ];

  it.each(scenarios)('$name: what stands there is removed right before', async (scenario) => {
    const s = await memorySite(scenario.first);
    await s.run();
    scenario.change(s);

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(siteFiles(s.server)).toEqual(scenario.expected);
    expect(await manifestPaths(s.server)).toEqual(scenario.expected);
    const folder = s.server.folders().includes('/home/site/docs');
    expect(folder).toBe(scenario.expected.includes('docs/a.html'));
  });

  it.each(scenarios)('$name: stopped at any change, a rerun finishes it', async (scenario) => {
    for (const code of ['permission', 'connection-lost'] as const) {
      for (let nth = 1; ; nth++) {
        const s = await memorySite(scenario.first, { quick: true });
        await s.run();
        scenario.change(s);
        // Stopped: the connection does not come back (no reconnect, spec #41 decision 20).
        const stopped = await s.run(onlyOnce(failingAt(s.server, nth, code)));
        // A failure at the lock's own removal leaves the lock (decision 0031): the rerun takes
        // it over once its note is 10 minutes old.
        s.passTime(10 * 60_000);
        const rerun = await s.run();
        const at = `${code} at change ${nth}`;
        expect(rerun.outcome, at).toMatchObject({ exitCode: 0 });
        // A lost connection can leave an upload's hidden temp file (R18); nothing reads it.
        const files = siteFiles(s.server).filter(
          (path) => !/\.sealup-[0-9a-f]{16}\.tmp$/.test(path),
        );
        expect(files, at).toEqual(scenario.expected);
        expect(await manifestPaths(s.server), at).toEqual(scenario.expected);
        // Past the last change the run did not stop: every point was tried.
        if (stopped.outcome.exitCode === 0) break;
      }
    }
  });

  it.each(scenarios)(
    '$name: a connection lost at any change, the run reconnects and finishes',
    async (scenario) => {
      // Changes 1 and 2 are the lock's folder and note, before the transfer: no reconnect there.
      for (let nth = 3; ; nth++) {
        const s = await memorySite(scenario.first, { quick: true });
        await s.run();
        scenario.change(s);
        // The first session loses its connection at its nth change; the next one is sound.
        let connects = 0;
        const dropping = failingAt(s.server, nth, 'connection-lost');
        const connect: Connect = (target, options) =>
          connects++ === 0 ? dropping(target, options) : s.server.connect();
        const { outcome } = await s.run(connect);
        const at = `connection lost at change ${nth}`;
        expect(outcome, at).toMatchObject({ status: 'ok', exitCode: 0 });
        expect(siteFiles(s.server), at).toEqual(scenario.expected);
        expect(await manifestPaths(s.server), at).toEqual(scenario.expected);
        // Past the transfer's last change (the lock's release, never reconnected): every point of
        // the transfer was tried.
        if (outcome.reconnects === undefined) break;
        expect(outcome.reconnects, at).toBe(1);
        // No lock is left: it went over to the new session and was released there.
        const locks = [...s.server.files().keys()].filter((path) => path.includes('.lock'));
        expect(locks, at).toEqual([]);
      }
    },
  );

  it('a file made by hand where a folder is needed: stops before any change (exit 6)', async () => {
    const s = await memorySite({ 'public_html/docs/a.html': 'a' });
    s.server.seedFile('/home/site/docs', 'by hand');
    const before = s.server.files();

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: {
        code: 'in-the-way',
        path: '/home/site/docs',
        found: 'file',
        held: 'not-uploaded',
        changed: false,
      },
    });
    expect(s.server.files()).toEqual(before);
  });

  it('a folder with a file made by hand where a file is needed: stops until it is moved', async () => {
    const s = await memorySite({ 'public_html/index.html': 'i', 'public_html/docs/a.html': 'a' });
    await s.run();
    s.server.seedFile('/home/site/docs/by-hand.txt', 'kept');
    s.remove('public_html/docs');
    s.write('public_html/docs', 'a file');

    const { outcome } = await s.run();

    const problem = {
      code: 'in-the-way',
      path: '/home/site/docs',
      found: 'folder',
      held: 'not-uploaded',
    };
    // docs/a.html, which sealup uploaded, made way: the server changed (exit 1).
    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      problem: { ...problem, changed: true },
    });
    expect(siteFiles(s.server)).toEqual(['docs/by-hand.txt', 'index.html']);
    const again = await s.run();
    expect(again.outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: { ...problem, changed: false },
    });
  });

  it('a kept (excluded) file in the folder a file must replace: blocked (exit 6)', async () => {
    const s = await memorySite({
      'public_html/docs/a.html': 'a',
      'public_html/docs/keep.txt': 'k',
    });
    await s.run();
    s.setConfig(
      productionConfig().replace('targets:', 'exclude: [public_html/docs/keep.txt]\ntargets:'),
    );
    s.remove('public_html/docs');
    s.write('public_html/docs', 'a file');
    const before = s.server.files();

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: {
        code: 'in-the-way',
        path: '/home/site/docs',
        found: 'folder',
        held: 'excluded',
        changed: false,
      },
    });
    expect(s.server.files()).toEqual(before);
  });
});
