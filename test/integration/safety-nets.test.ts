// The safety nets (spec #1, seam 1: deploy() behind the Session port): a failed build, a local
// symlink, a manifest sealup cannot trust and a manifest folder inside the target folder stop the
// run before anything changes on the server. Local side: real temp folders with spaces.

import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, type ResolvedConfig } from '../../src/config/index.ts';
import {
  type Connect,
  type DeployEvent,
  type Outcome,
  type ServerPath,
  type Session,
  TransportError,
} from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import { createProject, eventLog, hostKeyLine, productionConfig, ref } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

/** The config of a fresh project; `prepare` shapes its folder before the config is loaded. */
async function configOf(
  yaml: string,
  files: Readonly<Record<string, string>>,
  prepare: (root: string) => void = () => {},
): Promise<ResolvedConfig> {
  const project = createProject(yaml, files);
  prepare(project.root);
  const loaded = await loadConfig(project.config, env);
  if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
  return loaded.config;
}

interface Run {
  readonly outcome: Outcome;
  readonly events: readonly DeployEvent[];
  readonly connected: boolean;
}

/** Deploys `config` to `production`, noting whether it connected. */
async function run(config: ResolvedConfig, connect?: Connect): Promise<Run> {
  const log = eventLog();
  let connected = false;
  const outcome = await deploy(
    { config, target: 'production' },
    {
      connect: async (target, options) => {
        connected = true;
        if (connect === undefined) throw new Error('this run must not connect');
        return connect(target, options);
      },
      emit: log.emit,
      signal: undefined,
      clock: steppedClock(0),
    },
  );
  return { outcome, events: log.events, connected };
}

describe('safety net: empty or missing source folder (R20)', () => {
  it('stops an empty source folder before connecting, with exit 6 and no target block', async () => {
    const config = await configOf(productionConfig(), {}, (root) =>
      mkdirSync(join(root, 'public_html')),
    );
    const { outcome, events, connected } = await run(config);
    expect(connected).toBe(false);
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: {
        code: 'empty-source',
        folder: 'public_html',
        missing: false,
        serverFolder: '/home/site',
        target: 'production',
      },
    });
    expect(events.map((event) => event.type)).toEqual(['done']);
  });

  it('stops a missing source folder the same way', async () => {
    const config = await configOf(productionConfig({ upload: 'dist' }), { 'src/a.ts': 'x' });
    const { outcome, connected } = await run(config);
    expect(connected).toBe(false);
    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'empty-source', folder: 'dist', missing: true },
    });
  });

  it('counts a folder whose every file is excluded as empty', async () => {
    const yaml = `${productionConfig()}exclude: ['*.map']\n`;
    const config = await configOf(yaml, { 'public_html/app.js.map': 'x' });
    const { outcome, connected } = await run(config);
    expect(connected).toBe(false);
    expect(outcome).toMatchObject({ exitCode: 6, problem: { code: 'empty-source' } });
  });

  it('names the first empty folder of several, with where its files go', async () => {
    const yaml = productionConfig({ upload: '\n  public_html: www\n  api: api' });
    const config = await configOf(yaml, { 'public_html/index.html': 'x' }, (root) =>
      mkdirSync(join(root, 'api')),
    );
    const { outcome } = await run(config);
    expect(outcome.problem).toMatchObject({ folder: 'api', serverFolder: '/home/site/api' });
  });

  it('sends an empty folder when the target allows it, deleting what sealup uploaded', async () => {
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const first = await configOf(productionConfig(), { 'public_html/index.html': 'x' });
    expect((await run(first, () => server.connect())).outcome.exitCode).toBe(0);
    server.seedFile('/home/site/not-ours.txt', 'kept');

    const yaml = productionConfig().replace(
      '  production:\n',
      '  production:\n    allow: [empty-source]\n',
    );
    const config = await configOf(yaml, {}, (root) => mkdirSync(join(root, 'public_html')));
    const { outcome, events } = await run(config, () => server.connect());
    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 0, deleted: 1 });
    expect(events[0]).toMatchObject({ type: 'start' });
    const site = [...server.files().keys()].filter((path) => path.startsWith('/home/site/'));
    expect(site).toEqual(['/home/site/not-ours.txt']);
  });
});

describe('safety net: a symlink in a source folder', () => {
  it('stops before connecting with exit 6, naming the link from the config folder', async () => {
    const files = { 'public_html/my pages/index.html': 'x', 'secrets/id_rsa': 'not for the web' };
    const config = await configOf(productionConfig(), files, (root) => {
      const link = join(root, 'public_html', 'my pages', 'key');
      symlinkSync(join(root, 'secrets', 'id_rsa'), link, 'file');
    });
    const { outcome, events, connected } = await run(config);
    expect(connected).toBe(false);
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: {
        code: 'symlink',
        on: 'source',
        path: 'public_html/my pages/key',
        target: 'production',
      },
    });
    expect(events.map((event) => event.type)).toEqual(['done']);
  });

  it('stops on a linked folder too (a junction on Windows), without following it', async () => {
    const files = { 'public_html/index.html': 'x', 'elsewhere/a.txt': 'x' };
    const config = await configOf(productionConfig(), files, (root) => {
      symlinkSync(join(root, 'elsewhere'), join(root, 'public_html', 'shared'), 'junction');
    });
    const { outcome, connected } = await run(config);
    expect(connected).toBe(false);
    expect(outcome.problem).toMatchObject({
      code: 'symlink',
      on: 'source',
      path: 'public_html/shared',
    });
  });

  it('ignores an excluded symlink: it is never sent', async () => {
    const server = createMemoryServer();
    const yaml = `${productionConfig()}exclude: [public_html/shared]\n`;
    const files = { 'public_html/index.html': 'x', 'elsewhere/a.txt': 'x' };
    const config = await configOf(yaml, files, (root) => {
      symlinkSync(join(root, 'elsewhere'), join(root, 'public_html', 'shared'), 'junction');
    });
    const { outcome } = await run(config, () => server.connect());
    expect(outcome).toMatchObject({ status: 'ok', uploaded: 1 });
  });
});

describe('safety net: a manifest sealup cannot trust (R12, R21)', () => {
  const hash = 'ab'.repeat(32);
  const record = { path: 'index.html', size: 1, sha256: hash };
  const valid = { format: 2, folder: '/home/site', files: [record], pending: [] };
  const json = (value: unknown): string => JSON.stringify(value);
  /** The server's files by path and hash (comparing 50 MB of bytes would be slow). */
  const tree = (server: ReturnType<typeof createMemoryServer>): string[] =>
    [...server.files()].map(([path, file]) => `${path} ${file.sha256}`);

  type Spoil = (server: ReturnType<typeof createMemoryServer>, path: string) => Promise<void>;
  const seed =
    (content: string | Uint8Array): Spoil =>
    async (server, path) =>
      server.seedFile(path, content);

  it.each<[string, Spoil, 'invalid' | 'too-large' | 'unreadable']>([
    ['corrupt JSON', seed('{"format":1,"files":['), 'invalid'],
    ['a later format version', seed(json({ ...valid, format: 3 })), 'invalid'],
    ['format 1 with pending names', seed(json({ ...valid, format: 1 })), 'invalid'],
    // A planted manifest may not make the run remove a file of the site as a leftover (0032).
    [
      'a pending name that is a file of the site',
      seed(json({ ...valid, pending: ['index.html'] })),
      'invalid',
    ],
    ['no format version', seed(json({ folder: '/home/site', files: [record] })), 'invalid'],
    [
      'a `__proto__` key',
      seed('{"format":1,"folder":"/home/site","files":[],"__proto__":{}}'),
      'invalid',
    ],
    [
      'a `__proto__` key in a record',
      seed(
        json({ ...valid, files: [{ ...record, __proto__x: 1 }] }).replace(
          '__proto__x',
          '__proto__',
        ),
      ),
      'invalid',
    ],
    [
      'a `../` path',
      seed(json({ ...valid, files: [{ ...record, path: '../../.ssh/authorized_keys' }] })),
      'invalid',
    ],
    [
      'an absolute path',
      seed(json({ ...valid, files: [{ ...record, path: '/home/deploy/x' }] })),
      'invalid',
    ],
    ['another target folder', seed(json({ ...valid, folder: '/home' })), 'invalid'],
    [
      'over 50 MB',
      // Made when the test runs, not when the table is: built at collection time, the 50 MB
      // made the S07 and S09 hooks time out now and then in the full suite.
      async (server, path) => server.seedFile(path, new Uint8Array(50 * 1024 * 1024 + 1)),
      'too-large',
    ],
    [
      'a folder where the file should be',
      async (server, path) => {
        const session = await server.connect();
        await session.remove(path as ServerPath);
        server.seedFile(`${path}/inside`, 'x');
      },
      'unreadable',
    ],
  ])('stops on %s with exit 6, writing and deleting nothing', async (_, spoil, reason) => {
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const files = { 'public_html/index.html': 'x', 'public_html/old.html': 'old' };
    const first = await configOf(productionConfig(), files);
    expect((await run(first, () => server.connect())).outcome.exitCode).toBe(0);
    const manifest = [...server.files().keys()].find((path) => path.endsWith('.json'));
    if (manifest === undefined) throw new Error('no manifest after the first deploy');
    await spoil(server, manifest);
    const before = tree(server);

    // The next build changes a file and drops another: an upload and a delete, if trusted.
    const config = await configOf(productionConfig(), { 'public_html/index.html': 'new' });
    const { outcome, events } = await run(config, () => server.connect());

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: { code: 'manifest-unusable', reason },
    });
    expect(events.map((event) => event.type)).toEqual(['start', 'host-key', 'done']);
    expect(tree(server)).toEqual(before);
  });

  it('stops on a manifest the server refuses to let it read', async () => {
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const config = await configOf(productionConfig(), { 'public_html/index.html': 'x' });
    const refusing: Connect = async () => {
      const session = await server.connect();
      return {
        ...session,
        read: async () => {
          throw new TransportError('permission', 'answer', { operation: 'read' });
        },
      } satisfies Session;
    };
    const { outcome } = await run(config, refusing);
    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'manifest-unusable', reason: 'unreadable' },
    });
    expect(server.files().size).toBe(0);
  });
});

describe('a manifest folder inside the target folder (R14, ruling 9)', () => {
  /** One target: `server` and `manifest` as given; login folder /home/deploy. */
  const yaml = (server: string, manifest: string): string =>
    [
      `server: sftp://deploy@ssh.example.com${server}`,
      `password: ${ref('PROD_PASSWORD')}`,
      `hostKey: ${hostKeyLine}`,
      'upload: public_html',
      `manifest: ${manifest}`,
    ].join('\n');
  const files = { 'public_html/index.html': 'x' };

  /** Deploys the one target of `text`; `production` is not its name, so no target is named. */
  async function runOne(text: string, server = createMemoryServer()): Promise<Run> {
    const config = await configOf(text, files);
    const log = eventLog();
    let connected = false;
    const outcome = await deploy(
      { config, target: undefined },
      {
        connect: () => {
          connected = true;
          return server.connect();
        },
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0),
      },
    );
    return { outcome, events: log.events, connected };
  }

  it.each([
    ['both absolute', '/home/site', '/home/site/.sealup'],
    ['the same folder', '/home/site', '/home/site'],
    ['both in the login folder', '/~/www', 'www/private/.sealup'],
    ['the login folder as target, by default', '/~', '.sealup'],
  ])('refuses it before connecting with exit 2: %s', async (_, server, manifest) => {
    const { outcome, events, connected } = await runOne(yaml(server, manifest));
    expect(connected).toBe(false);
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 2,
      problem: { code: 'manifest-inside-target', connected: false },
    });
    expect(events.map((event) => event.type)).toEqual(['done']);
  });

  it('refuses it right after login when only the login folder tells, changing nothing', async () => {
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const { outcome, events } = await runOne(yaml('/home/deploy/www', 'www/.sealup'), server);
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 2,
      problem: {
        code: 'manifest-inside-target',
        manifestFolder: '/home/deploy/www/.sealup',
        targetFolder: '/home/deploy/www',
        connected: true,
      },
    });
    expect(events.map((event) => event.type)).toEqual(['start', 'host-key', 'done']);
    expect(server.files().size).toBe(0);
  });

  it.each([
    ['a sibling with the same prefix', '/home/deploy/site', '/home/deploy/site2/.sealup'],
    ['the target inside the manifest folder', '/~/.sealup/site', '.sealup'],
  ])('accepts %s', async (_, server, manifest) => {
    const { outcome } = await runOne(yaml(server, manifest));
    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0 });
  });
});
