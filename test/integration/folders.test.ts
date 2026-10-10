// deploy() behind the Session port (spec #1, seam 1): folders are made and removed a level at a
// time (ticket 20). The folders of one depth go at once, up to `parallel`; a level starts only
// once the one before it has finished, so a parent is always made before its children (mkdirs)
// and removed after them (rmdirs). One at a time, 795 mkdirs took 19 s of a 31 s first deploy on
// OVH. **[V]** spikes/06-channel-measure/README.md, 2026-10-08.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import {
  type Connect,
  type Outcome,
  type ServerPath,
  TransportError,
} from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import { createProject, eventLog, productionConfig } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const target = '/home/site/';

type FolderOp = 'mkdir' | 'rmdir';

interface Seen {
  readonly op: FolderOp;
  /** Relative to the target folder. */
  readonly path: string;
  readonly at: 'start' | 'end';
}

/**
 * A project deployed to one memory server, through a session that logs when each mkdir and rmdir
 * under the target folder starts and ends, and how many were in flight at most.
 */
function site(files: Record<string, string>, config: string = productionConfig()) {
  const project = createProject(config, files);
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  const seen: Seen[] = [];
  let inFlight = 0;
  let most = 0;
  /** Optional: what a folder op does instead of reaching the server. */
  let fail: ((op: FolderOp, path: string) => Promise<boolean> | undefined) | undefined;

  const watching: Connect = async () => {
    const session = await server.connect();
    const watched =
      (op: FolderOp, work: (path: ServerPath) => Promise<boolean>) =>
      async (path: ServerPath): Promise<boolean> => {
        if (!path.startsWith(target)) return work(path);
        const relative = path.slice(target.length);
        seen.push({ op, path: relative, at: 'start' });
        most = Math.max(most, ++inFlight);
        try {
          return await (fail?.(op, relative) ?? work(path));
        } finally {
          inFlight--;
          seen.push({ op, path: relative, at: 'end' });
        }
      };
    return {
      ...session,
      mkdir: watched('mkdir', session.mkdir),
      rmdir: watched('rmdir', session.rmdir),
    };
  };

  const run = async (): Promise<Outcome> => {
    const loaded = await loadConfig(project.config, env);
    if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
    seen.length = 0;
    most = 0;
    return deploy(
      { config: loaded.config, target: 'production' },
      { connect: watching, emit: eventLog().emit, signal: undefined, clock: steppedClock(0, 1) },
    );
  };

  return {
    server,
    run,
    /** Each folder op seen in the last run, in the order they started or ended. */
    seen: (): readonly Seen[] => seen,
    /** The most folder ops in flight at once in the last run. */
    most: (): number => most,
    failWith(how: (op: FolderOp, path: string) => Promise<boolean> | undefined) {
      fail = how;
    },
    remove(path: string) {
      rmSync(join(project.root, ...path.split('/')), { recursive: true });
    },
  };
}

const started = (seen: readonly Seen[], op: FolderOp): string[] =>
  seen.filter((s) => s.op === op && s.at === 'start').map((s) => s.path);

/** The index in `seen` where `path`'s op ended (-1 if it never did). */
const endOf = (seen: readonly Seen[], op: FolderOp, path: string): number =>
  seen.findIndex((s) => s.op === op && s.path === path && s.at === 'end');

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/');

describe('folders: made a level at a time', () => {
  const build = {
    'public_html/index.html': 'i',
    'public_html/a/x/q/1.js': '1',
    'public_html/a/y/2.js': '2',
    'public_html/b/z/3.js': '3',
    'public_html/c/4.js': '4',
  };

  it('makes the folders of one depth at once', async () => {
    const s = site(build);

    const outcome = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 5 });
    // a, b and c (depth 1) are all in flight together.
    expect(s.most()).toBe(3);
    expect(s.server.folders().filter((path) => path.startsWith(target))).toEqual(
      ['a', 'a/x', 'a/x/q', 'a/y', 'b', 'b/z', 'c'].map((path) => `${target}${path}`),
    );
  });

  it('starts a folder only once its parent has been made', async () => {
    const s = site(build);

    await s.run();

    const seen = s.seen();
    expect(started(seen, 'mkdir')).toEqual(['a', 'b', 'c', 'a/x', 'a/y', 'b/z', 'a/x/q']);
    seen.forEach((s, at) => {
      if (s.at !== 'start' || !s.path.includes('/')) return;
      const parent = endOf(seen, 'mkdir', parentOf(s.path));
      expect(parent, `${s.path} after its parent`).toBeGreaterThanOrEqual(0);
      expect(parent, `${s.path} after its parent`).toBeLessThan(at);
    });
  });

  it('keeps at most `parallel` folders in flight', async () => {
    const files: Record<string, string> = {};
    for (const folder of ['a', 'b', 'c', 'd', 'e']) files[`public_html/${folder}/f.js`] = folder;
    const s = site(files, `parallel: 2\n${productionConfig()}`);

    const outcome = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 5 });
    expect(started(s.seen(), 'mkdir')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.most()).toBe(2);
  });

  it('starts no new folder after one fails; the ones in flight finish', async () => {
    const s = site(
      {
        'public_html/a/x/1.js': '1',
        'public_html/b/2.js': '2',
        'public_html/c/3.js': '3',
        'public_html/d/4.js': '4',
      },
      `parallel: 2\n${productionConfig()}`,
    );
    s.failWith((op, path) =>
      op === 'mkdir' && path === 'b'
        ? Promise.reject(new TransportError('permission', 'answer'))
        : undefined,
    );

    const outcome = await s.run();

    // a and b were in flight together: a was made, b refused; c, d and a/x never started, and no
    // file was sent.
    expect(started(s.seen(), 'mkdir')).toEqual(['a', 'b']);
    expect(endOf(s.seen(), 'mkdir', 'a')).toBeGreaterThanOrEqual(0);
    expect(s.server.folders().filter((path) => path.startsWith(target))).toEqual([`${target}a`]);
    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      uploaded: 0,
      problem: { code: 'transport', changed: true, error: { code: 'permission' } },
    });
  });
});

describe('folders: removed a level at a time, deepest first', () => {
  it('removes the emptied folders of one depth at once, each after its children', async () => {
    const s = site({
      'public_html/index.html': 'i',
      'public_html/old/a/1.js': '1',
      'public_html/old/b/2.js': '2',
      'public_html/old/c/3.js': '3',
      'public_html/gone/4.js': '4',
    });
    await s.run();
    s.remove('public_html/old');
    s.remove('public_html/gone');

    const outcome = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, deleted: 4 });
    expect(s.server.folders().filter((path) => path.startsWith(target))).toEqual([]);
    const seen = s.seen();
    expect(started(seen, 'rmdir')).toEqual(['old/a', 'old/b', 'old/c', 'gone', 'old']);
    // old/a, old/b and old/c (depth 2) are all in flight together.
    expect(s.most()).toBe(3);
    const old = seen.findIndex((s) => s.op === 'rmdir' && s.path === 'old' && s.at === 'start');
    for (const child of ['old/a', 'old/b', 'old/c']) {
      expect(endOf(seen, 'rmdir', child), `${child} before old`).toBeLessThan(old);
    }
  });
});
