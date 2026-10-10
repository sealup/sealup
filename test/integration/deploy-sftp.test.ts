// deploy() behind the Session port (spec #1, seam 1) over real SFTP: the in-process ssh2 server
// and the real transport. The same deploy gives the same server tree and manifest as in memory;
// a problem before any change gives its events and its exit code (decision 0023).

import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ResolvedConfig } from '../../src/config/index.ts';
import type { Connect } from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import {
  createMemoryServer,
  createSftpServer,
  type SftpServer,
  steppedClock,
} from '../../src/testkit/index.ts';
import { createProject, eventLog, hostKeyLine, productionConfig } from '../deploy-kit.ts';
import { dialing } from '../sftp-kit.ts';

const site = {
  'public_html/index.html': '<h1>home</h1>',
  'public_html/my pages/about us.html': '<h1>about</h1>',
  'public_html/assets/js/app.js': 'console.log(1);',
  'public_html/assets/big.bin': 'z'.repeat(200_000),
  'public_html/empty.txt': '',
  'public_html/__proto__': 'R11',
};

const servers: SftpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function sftpServer(): Promise<SftpServer> {
  const server = await createSftpServer({ loginFolder: '/home/deploy' });
  servers.push(server);
  return server;
}

/** The page's config (target production, /home/site), pinning `pin` and reading its password. */
async function configFor(server: SftpServer, pin = server.hostKeyLine): Promise<ResolvedConfig> {
  const project = createProject(productionConfig().replace(hostKeyLine, pin), site);
  const loaded = await loadConfig(project.config, { PROD_PASSWORD: server.password });
  if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
  return loaded.config;
}

async function run(config: ResolvedConfig, connect: Connect) {
  const log = eventLog();
  const outcome = await deploy(
    { config, target: 'production' },
    { connect, emit: log.emit, signal: undefined, clock: steppedClock(0) },
  );
  return { outcome, events: log.events };
}

/** path → SHA-256 of every file on a server. */
function tree(server: { files(): ReadonlyMap<string, { readonly sha256: string }> }) {
  return Object.fromEntries([...server.files()].map(([path, file]) => [path, file.sha256]));
}

describe('deploy over SFTP', () => {
  it('leaves the same server tree and manifest as the memory server', async () => {
    const sftp = await sftpServer();
    const config = await configFor(sftp);
    const memory = createMemoryServer({ loginFolder: '/home/deploy' });

    const overSftp = await run(config, dialing(sftp));
    const inMemory = await run(config, () => memory.connect());

    expect(overSftp.outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 6 });
    expect(overSftp.outcome).toEqual(inMemory.outcome);
    // Progress events come in the order files arrive, which pipelining may change.
    const steps = (events: typeof overSftp.events) =>
      events.filter((event) => event.type !== 'progress');
    expect(steps(overSftp.events)).toEqual(steps(inMemory.events));
    expect(overSftp.events.length).toBe(inMemory.events.length);
    expect(tree(sftp)).toEqual(tree(memory));
    expect(Object.keys(tree(sftp))).toContainEqual(
      expect.stringMatching(/^\/home\/deploy\/\.sealup\/.*\.json$/),
    );
    expect(sftp.folders()).toEqual(memory.folders());
  });

  it('redeploys over SFTP: the files already there are not sent again', async () => {
    const sftp = await sftpServer();
    const config = await configFor(sftp);
    await run(config, dialing(sftp));
    const again = await run(config, dialing(sftp));
    expect(again.outcome).toMatchObject({ status: 'unchanged', uploaded: 0, unchanged: 6 });
  });
});

describe('deploy over SFTP: stopped before any change', () => {
  it('a changed host key: the received key in the events, exit 4, no password sent', async () => {
    const sftp = await sftpServer();
    const other = await sftpServer();
    const config = await configFor(sftp, other.hostKeyLine);

    const { outcome, events } = await run(config, dialing(sftp));

    expect(events.map((event) => event.type)).toEqual(['start', 'host-key', 'done']);
    expect(events[1]).toEqual({
      type: 'host-key',
      state: 'changed',
      received: { type: 'ssh-ed25519', fingerprint: sftp.fingerprint },
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 4,
      problem: { code: 'transport', changed: false, error: { code: 'host-key' } },
    });
    expect(sftp.logins()).toEqual([]);
    expect(sftp.files().size).toBe(0);
  });

  it('a refused login: the key was verified, exit 3, one attempt', async () => {
    const sftp = await sftpServer();
    sftp.faults.refuseLogin();
    const { outcome, events } = await run(await configFor(sftp), dialing(sftp));

    expect(events[1]).toEqual({
      type: 'host-key',
      state: 'verified',
      fingerprint: sftp.fingerprint,
    });
    expect(outcome).toMatchObject({ exitCode: 3, problem: { error: { code: 'auth' } } });
    expect(sftp.logins()).toEqual([{ method: 'password', accepted: false }]);
  });

  it('an unreachable server: the key was not checked, exit 5', async () => {
    const sftp = await sftpServer();
    const config = await configFor(sftp);
    await sftp.stop();
    servers.splice(servers.indexOf(sftp), 1);

    const { outcome, events } = await run(config, dialing(sftp));

    expect(events[1]).toEqual({ type: 'host-key', state: 'not-checked' });
    expect(outcome).toMatchObject({ exitCode: 5, problem: { error: { code: 'unreachable' } } });
  });

  it.each([
    ['invalid', 'not JSON', (path: string) => path],
    ['unreadable', 'a folder where the file should be', (path: string) => `${path}/inside`],
  ])(
    'a manifest sealup cannot trust (%s: %s): exit 6, nothing changed (R12)',
    async (reason, _, seedAt) => {
      // Where the manifest of this target lives: as the memory server shows it.
      const sftp = await sftpServer();
      const config = await configFor(sftp);
      const memory = createMemoryServer({ loginFolder: '/home/deploy' });
      await run(config, () => memory.connect());
      const manifest = [...memory.files().keys()].find((path) => path.endsWith('.json'));
      if (manifest === undefined) throw new Error('no manifest in memory');
      sftp.seedFile(seedAt(manifest), 'not json');
      const before = tree(sftp);

      const { outcome } = await run(config, dialing(sftp));

      expect(outcome).toMatchObject({
        exitCode: 6,
        problem: { code: 'manifest-unusable', reason },
      });
      expect(tree(sftp)).toEqual(before);
    },
  );
});
