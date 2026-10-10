// deploy() behind the Session port (spec #1, seam 1), against the memory server: the server tree,
// the manifest, the events and the Outcome. Local side: real temp folders with spaces.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, type ResolvedConfig } from '../../src/config/index.ts';
import type { Connect, ServerPath, Session, Sha256 } from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { manifestStore } from '../../src/manifest/index.ts';
import { createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import {
  createProject,
  eventLog,
  hostKeyFingerprint,
  hostKeyLine,
  productionConfig,
  ref,
} from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const site = {
  'public_html/index.html': '<h1>home</h1>',
  'public_html/my pages/about us.html': '<h1>about</h1>',
  'public_html/assets/js/app.js': 'console.log(1);',
  'public_html/__proto__': 'R11',
};

async function configOf(yaml: string, files: Record<string, string>): Promise<ResolvedConfig> {
  const project = createProject(yaml, files);
  const loaded = await loadConfig(project.config, env);
  if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
  return loaded.config;
}

function sha256(text: string): Sha256 {
  return createHash('sha256').update(text).digest('hex') as Sha256;
}

/** The memory server's connect, as deploy's Connect port. */
function connectTo(server: ReturnType<typeof createMemoryServer>): Connect {
  return () => server.connect();
}

describe('deploy: first deploy of a folder', () => {
  it('puts every file in the target folder, writes the manifest, and ends ok', async () => {
    const config = await configOf(productionConfig(), site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const log = eventLog();

    const outcome = await deploy(
      { config, target: 'production' },
      {
        connect: connectTo(server),
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0, 15_600),
      },
    );

    expect(outcome).toEqual({
      status: 'ok',
      exitCode: 0,
      uploaded: 4,
      written: 0,
      deleted: 0,
      unchanged: 0,
      bytes: 13 + 14 + 15 + 3,
      durationMs: 15_600,
      timings: expect.objectContaining({}),
    });

    const files = server.files();
    const tree = [...files.keys()].filter((path) => path.startsWith('/home/site/'));
    expect(tree).toEqual([
      '/home/site/__proto__',
      '/home/site/assets/js/app.js',
      '/home/site/index.html',
      '/home/site/my pages/about us.html',
    ]);
    expect(files.get('/home/site/my pages/about us.html')?.sha256).toBe(sha256('<h1>about</h1>'));

    // The manifest: in .sealup/ of the login folder, outside the target folder (R14).
    const session = await server.connect();
    const read = await manifestStore(session, {
      folder: '/home/deploy/.sealup' as ServerPath,
      target: '/home/site' as ServerPath,
    }).read();
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') return;
    expect(read.manifest.folder).toBe('/home/site');
    expect([...read.manifest.files]).toEqual([
      ['__proto__', { size: 3, sha256: sha256('R11') }],
      ['assets/js/app.js', { size: 15, sha256: sha256('console.log(1);') }],
      ['index.html', { size: 13, sha256: sha256('<h1>home</h1>') }],
      ['my pages/about us.html', { size: 14, sha256: sha256('<h1>about</h1>') }],
    ]);
    expect([...files.keys()].filter((path) => !path.startsWith('/home/site/'))).toEqual([
      expect.stringMatching(/^\/home\/deploy\/\.sealup\/home-site-[0-9a-f]{8}\.json$/),
    ]);
  });

  it('tells what happens, in order: start, host key, plan, progress per file, done', async () => {
    const config = await configOf(productionConfig(), site);
    const log = eventLog();
    const outcome = await deploy(
      { config, target: undefined },
      {
        connect: connectTo(createMemoryServer()),
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0),
      },
    );

    expect(log.events.map((event) => event.type)).toEqual([
      'start',
      'host-key',
      'plan',
      ...Array(4).fill('progress'),
      'done',
    ]);
    const [start, hostKey, plan] = log.events;
    const done = log.events.at(-1);
    expect(start).toMatchObject({ type: 'start', target: { name: 'production' } });
    expect(hostKey).toEqual({
      type: 'host-key',
      state: 'verified',
      fingerprint: hostKeyFingerprint,
    });
    expect(plan).toMatchObject({
      type: 'plan',
      plan: { firstDeploy: true, bytes: 45, unchanged: 0 },
    });
    expect(done).toEqual({ type: 'done', outcome });
  });

  it('writes each file under a random temp name in its folder, then renames it into place', async () => {
    const config = await configOf(productionConfig(), site);
    const server = createMemoryServer();
    const written: string[] = [];
    const recording: Connect = async () => {
      const session = await server.connect();
      return {
        ...session,
        put: (source, to) => {
          written.push(to);
          return session.put(source, to);
        },
      } satisfies Session;
    };

    await deploy(
      { config, target: 'production' },
      { connect: recording, emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );

    const finals = [...server.files().keys()];
    const uploads = written.filter((path) => path.startsWith('/home/site/'));
    expect(uploads).toHaveLength(4);
    for (const temp of uploads) {
      expect(finals).not.toContain(temp);
      const folder = temp.slice(0, temp.lastIndexOf('/'));
      expect(finals.some((final) => final.slice(0, final.lastIndexOf('/')) === folder)).toBe(true);
    }
    expect(new Set(uploads).size).toBe(4);
    expect(finals.some((path) => path.endsWith('.tmp'))).toBe(false);
  });

  it('resolves a /~/ folder against the login folder and creates it', async () => {
    const yaml = [
      'server: sftp://deploy@ssh.example.com/~/staging/site',
      `password: ${ref('PROD_PASSWORD')}`,
      `hostKey: ${hostKeyLine}`,
      'upload: public_html',
    ].join('\n');
    const config = await configOf(yaml, { 'public_html/index.html': 'x' });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const outcome = await deploy(
      { config, target: undefined },
      { connect: connectTo(server), emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );

    expect(outcome.exitCode).toBe(0);
    expect(server.files().has('/home/deploy/staging/site/index.html')).toBe(true);
  });

  it.each([
    ['from the login folder', 'staging/.sealup', '/home/deploy/staging/.sealup/'],
    ['absolute', '/home/deploy/private/.sealup', '/home/deploy/private/.sealup/'],
  ])('keeps the manifest in the folder `manifest:` names, %s', async (_, folder, expected) => {
    const yaml = [
      'server: sftp://deploy@ssh.example.com/~/staging/site',
      `password: ${ref('PROD_PASSWORD')}`,
      `hostKey: ${hostKeyLine}`,
      'upload: public_html',
      `manifest: ${folder}`,
    ].join('\n');
    const config = await configOf(yaml, { 'public_html/index.html': 'x' });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const outcome = await deploy(
      { config, target: undefined },
      { connect: connectTo(server), emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );

    expect(outcome.exitCode).toBe(0);
    const outside = [...server.files().keys()].filter((path) => !path.includes('/site/'));
    expect(outside).toEqual([expect.stringMatching(new RegExp(`^${expected}[^/]+\\.json$`))]);
  });

  it('measures each phase with the clock it was given', async () => {
    const config = await configOf(productionConfig(), site);
    const outcome = await deploy(
      { config, target: 'production' },
      {
        connect: connectTo(createMemoryServer()),
        emit: () => {},
        signal: undefined,
        // One tick per reading: start, scan, connect, compare and transfer each take 1 s.
        clock: steppedClock(...Array.from({ length: 20 }, (_, i) => i * 1000)),
      },
    );
    const { scan, connect, compare, transfer } = outcome.timings;
    for (const phase of [scan, connect, compare, transfer]) expect(phase).toBeGreaterThan(0);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(scan + connect + compare + transfer);
  });
});

describe('deploy: stops', () => {
  it('stops before connecting when the target has no host key (R7)', async () => {
    const config = await configOf(productionConfig({ hostKey: false }), site);
    const log = eventLog();
    let connected = false;
    const outcome = await deploy(
      { config, target: 'production' },
      {
        connect: async () => {
          connected = true;
          throw new Error('must not connect');
        },
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0),
      },
    );
    expect(connected).toBe(false);
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 4,
      problem: { code: 'host-key-missing' },
    });
    expect(log.events.map((event) => event.type)).toEqual(['start', 'host-key', 'done']);
    expect(log.events[1]).toEqual({ type: 'host-key', state: 'missing' });
  });

  it('answers exit 3 when the login is refused, and nothing changed', async () => {
    const config = await configOf(productionConfig(), site);
    const server = createMemoryServer();
    server.faults.refuseLogin();
    const outcome = await deploy(
      { config, target: 'production' },
      { connect: connectTo(server), emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 3,
      problem: { code: 'transport', changed: false, error: { code: 'auth' } },
    });
    expect(server.files().size).toBe(0);
  });

  it('records what arrived when an upload fails part-way, and answers exit 1', async () => {
    const config = await configOf(productionConfig(), site);
    const server = createMemoryServer();
    const connect: Connect = async () => {
      const session = await server.connect();
      // The third upload: the lock's note (decision 0031) is the first put.
      server.faults.failWrite(4, 'quota');
      return session;
    };
    const outcome = await deploy(
      { config, target: 'production' },
      { connect, emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );
    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      problem: { code: 'transport', changed: true, error: { code: 'quota' } },
    });

    const arrived = [...server.files().keys()].filter((path) => path.startsWith('/home/site/'));
    const session = await server.connect();
    const read = await manifestStore(session, {
      folder: '/home/deploy/.sealup' as ServerPath,
      target: '/home/site' as ServerPath,
    }).read();
    if (read.kind !== 'found') throw new Error('no manifest after a part-way run');
    expect([...read.manifest.files.keys()].map((path) => `/home/site/${path}`)).toEqual(arrived);
    expect(arrived.length).toBeGreaterThan(0);
    expect(arrived.length).toBeLessThan(4);
  });

  it('stops on a manifest it cannot trust, changing nothing (R12)', async () => {
    const config = await configOf(productionConfig(), site);
    const server = createMemoryServer();
    const first = await server.connect();
    await manifestStore(first, {
      folder: '/home/deploy/.sealup' as ServerPath,
      target: '/home/site' as ServerPath,
    }).write({ format: 2, folder: '/home/site' as ServerPath, files: new Map(), pending: [] });
    const [manifestPath] = server.files().keys();
    if (manifestPath === undefined) throw new Error('no manifest');
    server.seedFile(manifestPath, 'not json');

    const outcome = await deploy(
      { config, target: 'production' },
      { connect: connectTo(server), emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: { code: 'manifest-unusable', reason: 'invalid' },
    });
    expect([...server.files().keys()]).toEqual([manifestPath]);
  });

  it.each([['an unknown name', 'staging', { code: 'unknown-target', name: 'staging' }]] as const)(
    'stops with exit 2 on %s, before any event but done',
    async (_, name, problem) => {
      const config = await configOf(productionConfig(), site);
      const log = eventLog();
      const outcome = await deploy(
        { config, target: name },
        {
          connect: connectTo(createMemoryServer()),
          emit: log.emit,
          signal: undefined,
          clock: steppedClock(0),
        },
      );
      expect(outcome).toMatchObject({ status: 'failed', exitCode: 2, problem });
      expect(log.events.map((event) => event.type)).toEqual(['done']);
    },
  );

  it('stops with exit 2 when several targets exist and none is named', async () => {
    const yaml = [
      'upload: public_html',
      'targets:',
      ...['production', 'staging'].flatMap((name) => [
        `  ${name}:`,
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('PROD_PASSWORD')}`,
      ]),
    ].join('\n');
    const config = await configOf(yaml, site);
    const outcome = await deploy(
      { config, target: undefined },
      {
        connect: connectTo(createMemoryServer()),
        emit: () => {},
        signal: undefined,
        clock: steppedClock(0),
      },
    );
    expect(outcome).toMatchObject({
      exitCode: 2,
      problem: { code: 'target-not-named', names: ['production', 'staging'] },
    });
  });

  it("stops with exit 2 and the chosen target's config issues, before any event but done", async () => {
    const yaml = [
      productionConfig(),
      '  staging:',
      '    server: sftp://deploy@ssh.example.com/home/staging',
      `    password: ${ref('STAGING_PASSWORD')}`,
    ].join('\n');
    const config = await configOf(yaml, site);
    const log = eventLog();
    const outcome = await deploy(
      { config, target: 'staging' },
      {
        connect: connectTo(createMemoryServer()),
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0),
      },
    );
    expect(outcome).toMatchObject({
      exitCode: 2,
      problem: {
        code: 'config',
        target: 'staging',
        issues: [{ code: 'variable-not-set', variable: 'STAGING_PASSWORD' }],
      },
    });
    expect(log.events.map((event) => event.type)).toEqual(['done']);
  });
});
