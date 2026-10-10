// `sealup deploy` through main() over real SFTP (spec #1, seam 2): the in-process ssh2 server and
// the real transport. The canary password really goes to the server (it accepts only that one),
// and appears in no output and no file on the server (R1). An unreachable server stops with
// exit 5 and says nothing was changed (decision 0023).

import { afterEach, describe, expect, it } from 'vitest';
import {
  canaries,
  createMemoryServer,
  createSftpServer,
  expectNoLeaks,
  goldenText,
  type SftpServer,
} from '../../src/testkit/index.ts';
import {
  createProject,
  hostKeyLine,
  productionConfig,
  runMain,
  versionLine,
} from '../deploy-kit.ts';
import { closedPort, dialing, silentServer } from '../sftp-kit.ts';

const site = {
  'public_html/index.html': '<h1>home</h1>',
  'public_html/my pages/about us.html': '<h1>about</h1>',
  'public_html/assets/app.js': 'x'.repeat(100_000),
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sftpServer(): Promise<SftpServer> {
  const server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
  cleanups.push(() => server.stop());
  return server;
}

/** The page's project, pinning `server`'s key and reading the canary password. */
function projectFor(server: SftpServer) {
  const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' });
  return createProject(config.replace(hostKeyLine, server.hostKeyLine), site);
}

const bytesOf = (server: { files(): ReadonlyMap<string, { readonly bytes: Uint8Array }> }) =>
  Object.fromEntries([...server.files()].map(([path, file]) => [path, file.bytes]));

describe('sealup deploy over SFTP', () => {
  it('gives the same server tree and manifest as in memory, sending the canary password', async () => {
    const sftp = await sftpServer();
    const project = projectFor(sftp);
    const overSftp = await runMain(['deploy'], { cwd: project.root, connect: dialing(sftp) });
    const memory = createMemoryServer({ loginFolder: '/home/deploy' });
    const inMemory = await runMain(['deploy'], { cwd: project.root, server: memory });

    expect(overSftp.exitCode).toBe(0);
    expect(overSftp.stderr).toBe(inMemory.stderr);
    expect(bytesOf(sftp)).toEqual(bytesOf(memory));
    expect(sftp.logins()).toEqual([{ method: 'password', accepted: true }]);
    expectNoLeaks(bytesOf(sftp));
  });
});

describe('sealup deploy: an unreachable server (exit 5)', () => {
  it('says it cannot reach the server and that nothing was changed', async () => {
    const sftp = await sftpServer();
    const project = projectFor(sftp);
    const port = await closedPort();
    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      connect: dialing({ host: sftp.host, port }),
    });

    expect(run.exitCode).toBe(5);
    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy', 'production'),
          '  production  sftp://deploy@ssh.example.com:22/home/site',
          '  host key    not checked',
          '',
          '  ✗ Cannot reach ssh.example.com:22.',
          '    The connection was refused on that port.',
          '    Check the host and port in targets.production.server (sealup.yml line 4),',
          '    and that the server is up.',
          '',
          '    sealup did not log in. Nothing was changed on production.',
          '    More: sealup.dev/e/unreachable',
        ],
        { color: false },
      ),
    );
  });

  it('stops with exit 5 when nothing answers within the timeout', async () => {
    const sftp = await sftpServer();
    const silent = await silentServer();
    cleanups.push(silent.stop);
    const project = projectFor(sftp);
    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      // A short handshake bound keeps the test fast (default: `timeout`, never under 10 s).
      connect: dialing(silent, { handshakeTimeoutMs: 300 }),
    });
    expect(run.exitCode).toBe(5);
    expect(run.stderr).toContain('No answer from the server in 0.3 s.');
    expect(run.stderr).toContain('sealup did not log in. Nothing was changed on production.');
  });
});
