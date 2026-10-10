// deploy() behind the Session port (spec #41 decisions 22-23, decision 0032, ticket 11): a run
// killed in the middle loses little. The manifest (format 2) lists the temp names a run may have
// left (`pending`); the next run removes them before uploading (R18). During the transfer the
// manifest is written every 30 s, so the next run skips what had arrived; a run under 30 s
// writes it once.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Connect,
  type DeployEvent,
  type Manifest,
  type RemotePath,
  type ServerPath,
  type Session,
  TransportError,
} from '../../src/contracts/index.ts';
import { manifestStore } from '../../src/manifest/index.ts';
import {
  type MemorySite,
  memorySite,
  onlyOnce,
  productionConfig,
  siteFiles,
} from '../deploy-kit.ts';

const at = { folder: '/home/deploy/.sealup' as ServerPath, target: '/home/site' as ServerPath };
const left = '.b.html.sealup-0123456789abcdef.tmp';
const gone = 'sub/.c.html.sealup-fedcba9876543210.tmp';
/** A temp name of another tool or target: never listed, never touched. */
const stranger = '.x.html.sealup-00000000ffffffff.tmp';

async function manifestOf(site: MemorySite): Promise<Manifest> {
  const read = await manifestStore(await site.server.connect(), at).read();
  if (read.kind !== 'found') throw new Error(`no manifest (${read.kind})`);
  return read.manifest;
}

/** The server after a run that was killed: a temp file left, its name in the manifest. */
async function killedRunLeft(site: MemorySite, pending: readonly string[]): Promise<void> {
  site.server.seedFile(`/home/site/${left}`, 'half a file');
  site.server.seedFile(`/home/site/${stranger}`, 'not ours');
  const manifest = await manifestOf(site);
  await manifestStore(await site.server.connect(), at).write({
    ...manifest,
    pending: pending as RemotePath[],
  });
}

const temps = (site: MemorySite): string[] =>
  siteFiles(site.server).filter((path) => path.includes('.sealup-'));

/** The memory server's session, with each operation's name and path logged. */
function logging(site: MemorySite, log: string[]): Connect {
  return async () => {
    const session = await site.server.connect();
    return {
      ...session,
      put: (source, to, options) => {
        log.push(`put ${to}`);
        return session.put(source, to, options);
      },
      remove: (path) => {
        log.push(`remove ${path}`);
        return session.remove(path);
      },
    } satisfies Session;
  };
}

describe('the temp names a stopped run left (R18)', () => {
  it('are removed before the first upload, and the manifest lists none after', async () => {
    const site = await memorySite({ 'public_html/a.html': 'a', 'public_html/b.html': 'b' });
    await site.run();
    await killedRunLeft(site, [left, gone]);
    site.write('public_html/b.html', 'b2');
    const log: string[] = [];

    const { outcome } = await site.run(logging(site, log));

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 1, deleted: 0 });
    expect(temps(site)).toEqual([stranger]);
    // In the target folder: the lock's note (decision 0031) goes to the manifest folder first.
    const inSite = log.filter((line) => line.includes(' /home/site/'));
    expect(inSite.slice(0, 2).sort()).toEqual([
      `remove /home/site/${left}`,
      `remove /home/site/${gone}`,
    ]);
    expect(inSite[2]).toMatch(/^put \/home\/site\/\.b\.html\.sealup-[0-9a-f]{16}\.tmp$/);
    expect((await manifestOf(site)).pending).toEqual([]);
  });

  it('are removed even when there is nothing to upload, and the run still says unchanged', async () => {
    const site = await memorySite({ 'public_html/a.html': 'a', 'public_html/b.html': 'b' });
    await site.run();
    await killedRunLeft(site, [left]);

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({ status: 'unchanged', exitCode: 0, uploaded: 0, deleted: 0 });
    expect(temps(site)).toEqual([stranger]);
    expect(await manifestOf(site)).toMatchObject({ format: 2, pending: [] });
  });

  it('are left alone by a dry run', async () => {
    const site = await memorySite({ 'public_html/a.html': 'a', 'public_html/b.html': 'b' });
    await site.run();
    await killedRunLeft(site, [left]);
    site.write('public_html/b.html', 'b2');

    const { outcome } = await site.run(undefined, true);

    expect(outcome.exitCode).toBe(0);
    expect(temps(site).sort()).toEqual([left, stranger]);
    expect((await manifestOf(site)).pending).toEqual([left]);
  });

  it('a name the server will not remove stays listed for the next run, and the deploy goes on', async () => {
    const site = await memorySite({ 'public_html/a.html': 'a', 'public_html/b.html': 'b' });
    await site.run();
    await killedRunLeft(site, [left, gone]);
    site.write('public_html/b.html', 'b2');
    const refusing: Connect = async () => {
      const session = await site.server.connect();
      return {
        ...session,
        remove: async (path) => {
          if (path.endsWith(left)) {
            throw new TransportError('permission', 'answer', { path, operation: 'delete' });
          }
          return session.remove(path);
        },
      } satisfies Session;
    };

    const { outcome } = await site.run(refusing);

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 1 });
    expect((await manifestOf(site)).pending).toEqual([left]);
  });
});

/** Lets the run go on until `done()` holds (at most 5 s). */
async function until(done: () => boolean): Promise<void> {
  const started = performance.now();
  while (!done()) {
    if (performance.now() - started > 5_000) throw new Error('waited 5 s');
    await sleep(1);
  }
}

const isManifest = (path: string): boolean => path.startsWith('/home/deploy/.sealup/');
const relative = (path: string): string => path.slice('/home/site/'.length);
const oneAtATime = {
  config: `parallel: 1
${productionConfig()}`,
};
const uploadsOf = (events: readonly DeployEvent[]): string[] =>
  events.flatMap((event) =>
    event.type === 'plan'
      ? event.plan.ops.filter((op) => op.op === 'upload').map((op) => op.path)
      : [],
  );

describe('checkpoints: the manifest during the transfer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a run under 30 s writes the manifest once, at its end', async () => {
    const site = await memorySite({ 'public_html/a.html': 'a', 'public_html/b.html': 'b' });
    const writes: string[] = [];
    const counting: Connect = async () => {
      const session = await site.server.connect();
      return {
        ...session,
        rename: async (from, to) => {
          await session.rename(from, to);
          if (isManifest(to)) writes.push(to);
        },
      } satisfies Session;
    };

    const { outcome } = await site.run(counting);

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 2 });
    expect(writes).toHaveLength(1);
  });

  it('is written every 30 s, with the uploads in flight under their temp names, and not again when nothing changed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const site = await memorySite(
      { 'public_html/a.html': 'a', 'public_html/b.html': 'b' },
      oneAtATime,
    );
    const writes: string[] = [];
    let held: string | undefined;
    let release = (): void => {};
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Connect = async () => {
      const session = await site.server.connect();
      return {
        ...session,
        // b.html takes a long time to send.
        put: async (source, to, options) => {
          if (to.includes('/.b.html.sealup-')) {
            held = to;
            await holding;
          }
          await session.put(source, to, options);
        },
        rename: async (from, to) => {
          await session.rename(from, to);
          if (isManifest(to)) writes.push(to);
        },
      } satisfies Session;
    };

    const running = site.run(slow);
    await until(() => held !== undefined);
    vi.advanceTimersByTime(30_000);
    await until(() => writes.length === 1);
    const checkpoint = await manifestOf(site);
    expect([...checkpoint.files.keys()]).toEqual(['a.html']);
    expect(checkpoint.pending).toEqual([relative(held ?? '')]);
    // 30 s on, b.html is still on its way: nothing to record that is not recorded.
    vi.advanceTimersByTime(30_000);
    release();
    const { outcome } = await running;

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 2 });
    expect(writes).toHaveLength(2);
    const final = await manifestOf(site);
    expect([...final.files.keys()]).toEqual(['a.html', 'b.html']);
    expect(final.pending).toEqual([]);
  });

  it('a run killed mid-upload: the next one sends only what had not arrived, and leaves no temp file', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const site = await memorySite(
      { 'public_html/a.html': 'a', 'public_html/b.html': 'b', 'public_html/c.html': 'c' },
      oneAtATime,
    );
    const writes: string[] = [];
    const killed: Connect = async () => {
      const session = await site.server.connect();
      return {
        ...session,
        rename: async (from, to) => {
          if (to === '/home/site/c.html') {
            // c.html sits under its temp name; 30 s have passed since the transfer began; then
            // the laptop closes: nothing more reaches the server.
            vi.advanceTimersByTime(30_000);
            await until(() => writes.length === 1);
            await session.close();
            throw new TransportError('connection-lost', 'lost');
          }
          await session.rename(from, to);
          if (isManifest(to)) writes.push(to);
        },
      } satisfies Session;
    };

    // Killed: no reconnect (spec #41 decision 20) reaches the server either.
    const stopped = await site.run(onlyOnce(killed));

    expect(stopped.outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      uploaded: 2,
      problem: { run: { arrived: 2, recorded: false } },
    });
    const [temp] = temps(site);
    expect(temps(site)).toEqual([expect.stringMatching(/^\.c\.html\.sealup-[0-9a-f]{16}\.tmp$/)]);
    expect(await manifestOf(site)).toMatchObject({ pending: [temp] });

    // The killed run's lock stays: the next run takes it over once its note is 10 minutes old.
    site.passTime(10 * 60_000);
    const rerun = await site.run();

    expect(uploadsOf(rerun.events)).toEqual(['c.html']);
    expect(rerun.outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 1 });
    expect(temps(site)).toEqual([]);
    const final = await manifestOf(site);
    expect([...final.files.keys()].sort()).toEqual(['a.html', 'b.html', 'c.html']);
    expect(final.pending).toEqual([]);
  });
});
