// Files written from a secret (`write:`, R17, owner ruling 8; seam 1, deploy() behind the Session
// port): built in memory, uploaded under a random hidden name with mode 0600 before the first
// byte, then renamed; never in the manifest, never deleted; rewritten only when the server copy
// differs. Over the memory server, then the same deploy over real SFTP.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import type { Connect, PutOptions, ServerPath, Source } from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import {
  createProject,
  hostKeyLine,
  manifestPaths,
  memorySite,
  productionConfig,
  ref,
  siteFiles,
} from '../deploy-kit.ts';
import { dialing, testServer } from '../sftp-kit.ts';

const build = { 'public_html/index.html': '<h1>home</h1>' };
const appEnv = 'APP_ENV=production\nAPP_KEY=fake-app-key-1\n';
const env = { APP_ENV: appEnv };

/** The page's production target, uploading public_html, with these lines added at the end. */
const config = (...lines: string[]): string =>
  `${productionConfig({ upload: 'public_html' })}${lines.join('\n')}\n`;
/** `write: { api/.env: ${APP_ENV} }`: lines 8 and 9 of the config. */
const writingEnv = config('write:', `  api/.env: ${ref('APP_ENV')}`);

const noConnect: Connect = () => {
  throw new Error('this run must not connect');
};

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

interface Put {
  readonly to: ServerPath;
  readonly mode: number | undefined;
  readonly from: 'file' | 'bytes' | 'secret';
}

/** A connect that records every put: where it went, with which mode, from what kind of source. */
function recording(server: ReturnType<typeof createMemoryServer>): {
  readonly connect: Connect;
  readonly puts: Put[];
} {
  const puts: Put[] = [];
  const connect: Connect = async () => {
    const session = await server.connect();
    return {
      ...session,
      put(source: Source, to: ServerPath, options?: PutOptions) {
        const from = 'file' in source ? 'file' : 'bytes' in source ? 'bytes' : 'secret';
        puts.push({ to, mode: options?.mode, from });
        return session.put(source, to, options);
      },
    };
  };
  return { connect, puts };
}

describe('write: a file from a secret, deployed', () => {
  it('writes it from memory under a random hidden name, mode 0600 from its first byte, then renames it', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    const { connect, puts } = recording(s.server);

    const { outcome } = await s.run(connect);

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 1, written: 1 });
    const file = s.server.files().get('/home/site/api/.env');
    expect(text(file?.bytes)).toBe(appEnv);
    expect(file?.mode).toBe(0o600);
    expect(file?.firstByteMode).toBe(0o600);
    const [put] = puts.filter((p) => p.from === 'secret');
    expect(put?.mode).toBe(0o600);
    expect(put?.to).toMatch(/^\/home\/site\/api\/\.\.env\.sealup-[0-9a-f]{16}\.tmp$/);
    expect(siteFiles(s.server)).toEqual(['api/.env', 'index.html']);
    // Not tool-owned: no record of it, so no hash of a secret on the server (owner ruling 8).
    expect(await manifestPaths(s.server)).toEqual(['index.html']);
  });

  it('uses a fresh random temp name each time', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    const { connect, puts } = recording(s.server);
    await s.run(connect);
    s.setEnv({ APP_ENV: `${appEnv}APP_DEBUG=false\n` });
    await s.run(connect);
    const temps = puts.filter((p) => p.from === 'secret').map((p) => p.to);
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
  });

  it('leaves it alone when the server holds it as it is: the redeploy is unchanged', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    await s.run();
    const { connect, puts } = recording(s.server);

    const { outcome } = await s.run(connect);

    expect(outcome).toMatchObject({ status: 'unchanged', uploaded: 0, written: 0, unchanged: 2 });
    // Nothing but the lock's note (decision 0031), in the manifest folder.
    expect(puts.map((put) => put.to)).toEqual([expect.stringMatching(/\.json\.lock\/note\.json$/)]);
  });

  it('rewrites it when the secret changed, or the server copy did', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    await s.run();
    s.setEnv({ APP_ENV: 'APP_ENV=production\nAPP_KEY=fake-app-key-2\n' });
    expect((await s.run()).outcome).toMatchObject({ status: 'ok', written: 1, unchanged: 1 });
    expect(text(s.server.files().get('/home/site/api/.env')?.bytes)).toContain('fake-app-key-2');

    s.server.seedFile('/home/site/api/.env', 'edited by hand, longer than the secret itself', {
      mode: 0o644,
    });
    expect((await s.run()).outcome).toMatchObject({ status: 'ok', written: 1 });
    const file = s.server.files().get('/home/site/api/.env');
    expect(text(file?.bytes)).toContain('fake-app-key-2');
    expect(file?.mode).toBe(0o600);
  });

  // R17, decision 24: the same content under a looser mode (sam-sync's 0644 .env) is not the file
  // the config asks for, so it is rewritten with its mode.
  it('rewrites it when the server copy has the same content and another mode', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    await s.run();
    s.server.seedFile('/home/site/api/.env', appEnv, { mode: 0o644 });

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', written: 1, unchanged: 1 });
    const file = s.server.files().get('/home/site/api/.env');
    expect(text(file?.bytes)).toBe(appEnv);
    expect(file?.mode).toBe(0o600);
    expect((await s.run()).outcome).toMatchObject({ status: 'unchanged', written: 0 });
  });

  it('takes the long form: another mode, kept on a redeploy once set', async () => {
    const s = await memorySite(build, {
      config: config('write:', '  api/.env:', `    from: ${ref('APP_ENV')}`, `    mode: '0640'`),
      env,
    });
    await s.run();
    expect(s.server.files().get('/home/site/api/.env')?.mode).toBe(0o640);
    expect((await s.run()).outcome).toMatchObject({ status: 'unchanged', written: 0 });
    s.setConfig(config('write:', `  api/.env: ${ref('APP_ENV')}`));
    expect((await s.run()).outcome).toMatchObject({ status: 'ok', written: 1 });
    expect(s.server.files().get('/home/site/api/.env')?.mode).toBe(0o600);
  });

  it('forgets it once its entry is gone: never deleted (owner ruling 8)', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    await s.run();
    s.setConfig(config());

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'unchanged', deleted: 0 });
    expect(text(s.server.files().get('/home/site/api/.env')?.bytes)).toBe(appEnv);
  });

  it('never deletes a path an old manifest recorded as an upload; the next manifest leaves it out', async () => {
    const s = await memorySite(
      { ...build, 'config/env.prod': 'APP_ENV=from-git\n' },
      {
        config: productionConfig({
          upload: ['', '  public_html: .', '  config/env.prod: api/.env'].join('\n'),
        }),
        env,
      },
    );
    await s.run();
    expect(await manifestPaths(s.server)).toEqual(['api/.env', 'index.html']);
    s.setConfig(
      `${productionConfig({ upload: ['', '  public_html: .'].join('\n') })}write:\n  api/.env: ${ref('APP_ENV')}\n`,
    );

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 0, written: 1, deleted: 0 });
    expect(text(s.server.files().get('/home/site/api/.env')?.bytes)).toBe(appEnv);
    expect(await manifestPaths(s.server)).toEqual(['index.html']);
  });

  it('a dry run changes nothing, and counts what it would write', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    const { outcome } = await s.run(undefined, true);
    expect(outcome).toMatchObject({ status: 'ok', uploaded: 1, written: 1 });
    expect(s.server.files().size).toBe(0);
  });
});

describe('write: a run that stops part-way', () => {
  it('says the file from a secret is missing, and the rerun writes it', async () => {
    const s = await memorySite(build, { config: writingEnv, env });
    // The lock's note (decision 0031) is the first put, the upload the second, the write the third.
    s.server.faults.failWrite(3, 'quota');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      uploaded: 1,
      written: 0,
      failed: [{ path: 'api/.env', code: 'quota' }],
      problem: { code: 'transport', run: { uploads: 1, arrived: 1, writes: 1, written: 0 } },
    });
    expect(s.server.files().has('/home/site/api/.env')).toBe(false);
    expect((await s.run()).outcome).toMatchObject({ status: 'ok', uploaded: 0, written: 1 });
  });
});

describe('write: stopped before connecting', () => {
  it('a write path an upload also sends: exit 2 naming both lines, nothing sent', async () => {
    const s = await memorySite(
      { ...build, 'public_html/api/.env': 'APP_ENV=local\n' },
      { config: writingEnv, env },
    );

    const { outcome, events } = await s.run(noConnect);

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 2,
      problem: {
        code: 'config',
        target: 'production',
        issues: [
          {
            code: 'same-server-path',
            line: 9,
            keyPath: 'write.api/.env',
            other: { line: 1, keyPath: 'upload' },
            path: 'api/.env',
          },
        ],
      },
    });
    expect(events.map((event) => event.type)).toEqual(['done']);
  });

  it('two write entries on one path, shared and the target own: exit 2', async () => {
    const s = await memorySite(build, {
      config: writingEnv.replace(
        '    url: https://example.com\n',
        `    url: https://example.com\n    write:\n      api/.env: ${ref('APP_ENV')}\n`,
      ),
      env,
    });
    const { outcome } = await s.run(noConnect);
    expect(outcome).toMatchObject({
      exitCode: 2,
      problem: { issues: [{ code: 'same-server-path', path: 'api/.env' }] },
    });
  });

  it('a secret file into a folder that looks public: exit 6, unless allowPublic', async () => {
    const s = await memorySite(build, {
      config: config('write:', `  www/config.php: ${ref('APP_ENV')}`),
      env,
    });

    const { outcome, events } = await s.run(noConnect);

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 6,
      problem: {
        code: 'secret-file-public',
        path: '/home/site/www/config.php',
        folder: 'www',
        place: { line: 9, keyPath: 'write.www/config.php' },
        target: 'production',
      },
    });
    expect(events.map((event) => event.type)).toEqual(['done']);

    s.setConfig(
      config('write:', '  www/config.php:', `    from: ${ref('APP_ENV')}`, '    allowPublic: true'),
    );
    expect((await s.run()).outcome).toMatchObject({ status: 'ok', written: 1 });
  });
});

describe('write over SFTP', () => {
  it('leaves the same tree as the memory server, mode 0600, and is unchanged on a redeploy', async () => {
    const sftp = await testServer({ loginFolder: '/home/deploy' });
    const project = createProject(writingEnv.replace(hostKeyLine, sftp.hostKeyLine), build);
    const loaded = await loadConfig(project.config, { PROD_PASSWORD: sftp.password, ...env });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const run = (connect: Connect) =>
      deploy(
        { config: loaded.config, target: 'production' },
        { connect, emit: () => {}, signal: undefined, clock: steppedClock(0) },
      );
    const memory = createMemoryServer({ loginFolder: '/home/deploy' });

    const overSftp = await run(dialing(sftp));
    const inMemory = await run(() => memory.connect());

    expect(overSftp).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 1, written: 1 });
    expect(overSftp).toEqual(inMemory);
    const tree = (server: typeof memory | typeof sftp) =>
      Object.fromEntries([...server.files()].map(([path, file]) => [path, file.sha256]));
    expect(tree(sftp)).toEqual(tree(memory));
    const file = sftp.files().get('/home/site/api/.env');
    expect(text(file?.bytes)).toBe(appEnv);
    expect(file?.mode).toBe(0o600);
    expect(file?.firstByteMode).toBe(0o600);

    expect(await run(dialing(sftp))).toMatchObject({
      status: 'unchanged',
      written: 0,
      unchanged: 2,
    });
  });
});
