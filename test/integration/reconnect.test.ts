// Reconnect and resume (S11, spec #41 decisions 20-21; plan 05 T13), through main() (seam 1):
// after the first login, a connection lost or a timeout during the transfer reconnects (3 tries,
// waiting 1, 2, then 4 s), checks the host key again, and sends only what is left; a refused
// login on reconnect stops at once. The fault suites' dropped connections, on the memory server,
// the in-process SFTP server and the in-process FTP server.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Connect,
  type ServerPath,
  type Session,
  TransportError,
} from '../../src/contracts/index.ts';
import {
  canaries,
  createFtpServer,
  createMemoryServer,
  createSftpServer,
} from '../../src/testkit/index.ts';
import { keepalive } from '../../src/transport/index.ts';
import {
  createProject,
  hostKeyLine,
  manifestPaths,
  memorySite,
  productionConfig,
  ref,
  runMain,
  siteFiles,
} from '../deploy-kit.ts';
import { dialing } from '../sftp-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Ten pages, sent one at a time so a drop falls between two known files. */
function tenPages(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`public_html/p${i}.html`] = `page ${i}`;
  return files;
}
const pages = Array.from({ length: 10 }, (_, i) => `p${i}.html`).sort();

/** One page at a time, to the page's production target. */
const oneAtATime = (config = productionConfig()): string => `parallel: 1\n${config}`;

/** The first connect goes to `connect`; every later one to `then`. */
function firstThen(connect: Connect, then: Connect): Connect {
  let count = 0;
  return (target, options) => (count++ === 0 ? connect(target, options) : then(target, options));
}

const refused = async (): Promise<Session> => {
  throw new TransportError('unreachable', 'refused');
};

/** Every path the memory server holds under the target folder that is a sealup temp name. */
const temps = (paths: readonly string[]): string[] =>
  paths.filter((path) => path.includes('.sealup-'));

describe('a connection lost during the transfer', () => {
  it('reconnects, sends what is left, and ends well (exit 0)', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    // The lock's note is the first put: the fifth upload is put 6.
    server.faults.failWrite(6, 'connection-lost');

    const run = await runMain(['deploy'], { cwd: project.root, env, server });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      '  ! Connection lost after 4 of 10 files. Reconnecting (1 of 3)…\n' +
        '    Reconnected. Resuming: 6 files left.\n',
    );
    expect(run.stderr).toContain('    reconnected once · https://example.com\n');
    expect(siteFiles(server).sort()).toEqual(pages);
    // The manifest records every file; no temp name is left behind, and neither is the lock.
    expect(await manifestPaths(server)).toEqual(pages);
    expect(temps([...server.files().keys()])).toEqual([]);
    expect([...server.files().keys()].filter((path) => path.includes('.lock'))).toEqual([]);
  });

  it('reconnects after a timeout too', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.faults.failWrite(6, 'timeout');

    const run = await runMain(['deploy'], { cwd: project.root, env, server });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      '  ! ssh.example.com stopped answering after 4 of 10 files. Reconnecting (1 of 3)…\n',
    );
    expect(siteFiles(server).sort()).toEqual(pages);
  });

  it('waits 1, 2, then 4 s between 3 tries, then stops on the lost connection (exit 1)', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.faults.failWrite(6, 'connection-lost');
    const waits: number[] = [];

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env,
      connect: firstThen(() => server.connect(), refused),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      [
        '  ! Connection lost after 4 of 10 files. Reconnecting (1 of 3)…',
        '  ! Still no connection. Reconnecting (2 of 3)…',
        '  ! Still no connection. Reconnecting (3 of 3)…',
      ].join('\n'),
    );
    expect(run.stderr).toContain('✗ Upload stopped: the connection to ssh.example.com was lost.');
    expect(run.stderr).toContain('    More: sealup.dev/e/connection-lost');
  });

  it('never retries the first connect (exit 5)', async () => {
    const project = createProject(oneAtATime(), tenPages());
    let connects = 0;
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env,
      connect: async () => {
        connects++;
        return refused();
      },
    });

    expect(connects).toBe(1);
    expect(run.exitCode).toBe(5);
    expect(run.stderr).not.toContain('Reconnecting');
  });

  it('stops at once when the login is refused on reconnect (exit 3, I-072)', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.faults.failWrite(6, 'connection-lost');
    let tries = 0;

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env,
      connect: firstThen(
        () => server.connect(),
        async () => {
          tries++;
          throw new TransportError('auth', 'login-refused');
        },
      ),
    });

    expect(tries).toBe(1);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain('Reconnecting (1 of 3)…');
    expect(run.stderr).not.toContain('(2 of 3)');
  });

  it('stops after 3 tries when every new connection drops at once', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.faults.failWrite(6, 'connection-lost');
    let tries = 0;
    // Each new session loses its connection on its first request: nothing more gets done.
    const dropping = async (): Promise<Session> => {
      tries++;
      const session = await server.connect();
      return {
        ...session,
        read: async () => {
          throw new TransportError('connection-lost', 'lost');
        },
        put: async () => {
          throw new TransportError('connection-lost', 'lost');
        },
        remove: async () => {
          throw new TransportError('connection-lost', 'lost');
        },
        mkdir: async () => {
          throw new TransportError('connection-lost', 'lost');
        },
        stat: async () => {
          throw new TransportError('connection-lost', 'lost');
        },
      };
    };

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env,
      connect: firstThen(() => server.connect(), dropping),
    });

    expect(tries).toBe(3);
    expect(run.exitCode).toBe(1);
  });

  it('stops on Ctrl-C during the wait (exit 130)', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.faults.failWrite(6, 'connection-lost');
    const controller = new AbortController();
    let connects = 0;

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env,
      signal: controller.signal,
      connect: async () => {
        connects++;
        return server.connect();
      },
      wait: async () => controller.abort(),
    });

    expect(connects).toBe(1);
    expect(run.exitCode).toBe(130);
    expect(run.stderr).toContain('✗ Stopped: sealup was interrupted (Ctrl-C).');
  });

  it('still puts back a file the server check found changed, when it had not arrived', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    expect((await runMain(['deploy'], { cwd: project.root, env, server })).exitCode).toBe(0);
    // Edited by hand on the server; and two pages changed here, sent before it.
    server.seedFile('/home/site/p9.html', new TextEncoder().encode('edited by hand'));
    writeFileSync(join(project.root, 'public_html/p0.html'), 'page 0, v2');
    writeFileSync(join(project.root, 'public_html/p1.html'), 'page 1, v2');
    // The lock's note is put 1: the second upload (p1.html) is put 3.
    server.faults.failWrite(3, 'connection-lost');

    const run = await runMain(['deploy', '--check-server'], { cwd: project.root, env, server });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain('Reconnected. Resuming: 2 files left.');
    const text = (path: string) => new TextDecoder().decode(server.files().get(path)?.bytes);
    expect(text('/home/site/p9.html')).toBe('page 9');
    expect(text('/home/site/p1.html')).toBe('page 1, v2');
  });

  it('keeps a recorded file that is now a link on the server, after the reconnect too', async () => {
    const config = `parallel: 1\n${productionConfig()}    allow: [symlinks]\n`;
    const site = await memorySite(
      { ...tenPages(), 'public_html/config.php': 'v1' },
      { config, quick: true },
    );
    expect((await site.run()).outcome.exitCode).toBe(0);
    // config.php becomes a link on the server (decision 28: never deleted); the pages change.
    const hand = await site.server.connect();
    await hand.remove('/home/site/config.php' as ServerPath);
    await hand.close();
    site.server.seedLink('/home/site/config.php', '../outside');
    site.remove('public_html/config.php');
    for (let i = 0; i < 10; i++) site.write(`public_html/p${i}.html`, `page ${i}, v2`);
    site.server.faults.failWrite(3, 'connection-lost');

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, deleted: 0, reconnects: 1 });
    const look = await site.server.connect();
    expect((await look.stat('/home/site/config.php' as ServerPath)).kind).toBe('link');
    await look.close();
  });

  it('gives --json the reconnects and the reconnect time', async () => {
    const project = createProject(oneAtATime(), tenPages());
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    server.faults.failWrite(6, 'connection-lost');

    const run = await runMain(['deploy', '--json'], { cwd: project.root, env, server });

    const json = JSON.parse(run.stdout);
    expect(json).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 10, reconnects: 1 });
    expect(Object.keys(json.timings)).toEqual([
      'connect',
      'scan',
      'compare',
      'transfer',
      'reconnect',
    ]);
    // Keys added later come after every key of the first version (0026 point 4).
    expect(Object.keys(json).at(-1)).toBe('reconnects');
  });
});

describe('a half-dead SSH link (spec #41 decision 21)', () => {
  it('is noticed through ssh2 keepalives: every 10 s, ended after 3 unanswered', () => {
    expect(keepalive).toEqual({ keepaliveInterval: 10_000, keepaliveCountMax: 3 });
  });
});

describe('over SFTP (the real transport)', () => {
  async function sftpServer() {
    const server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    cleanups.push(() => server.stop());
    return server;
  }

  it('reconnects after a dropped connection and sends what is left', async () => {
    const sftp = await sftpServer();
    const config = oneAtATime(productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }));
    const project = createProject(config.replace(hostKeyLine, sftp.hostKeyLine), tenPages());
    sftp.faults.failWrite(6, 'connection-lost');

    const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(sftp) });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain('Reconnected. Resuming: 6 files left.');
    const site = [...sftp.files().keys()].filter((path) => path.startsWith('/home/site/'));
    expect(site.map((path) => path.slice('/home/site/'.length)).sort()).toEqual(pages);
    expect(sftp.logins().filter((login) => login.accepted)).toHaveLength(2);
    // The lock went over to the new session and was released there; no temp name is left.
    const all = [...sftp.files().keys()];
    expect(all.filter((path) => path.includes('.lock'))).toEqual([]);
    expect(temps(all)).toEqual([]);
  });

  it('checks the host key again: another server on reconnect stops at once (exit 4, R7)', async () => {
    const sftp = await sftpServer();
    const other = await sftpServer();
    const config = oneAtATime(productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }));
    const project = createProject(config.replace(hostKeyLine, sftp.hostKeyLine), tenPages());
    sftp.faults.failWrite(6, 'connection-lost');

    const run = await runMain(['deploy'], {
      cwd: project.root,
      connect: firstThen(dialing(sftp), dialing(other)),
    });

    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain('Reconnecting (1 of 3)…');
    expect(run.stderr).not.toContain('(2 of 3)');
    // The password never reached the other server: the key exchange stopped first.
    expect(other.logins()).toEqual([]);
    // The same command again would stop the same way: the words give the step before it.
    expect(run.stderr).toContain(
      [
        '  ✗ Upload stopped: ssh.example.com showed another host key on reconnect.',
        '    The password was not sent there: it may not be your server.',
      ].join('\n'),
    );
    expect(run.stderr).toContain(
      [
        "    Ask your host for the server's fingerprint. If it changed, pin the new one:",
        '      sealup keyscan production   then commit sealup.yml.',
        '',
        '    production now has 4 of 10 new files.',
        '    Once the new key is pinned, run the same command again to finish.',
      ].join('\n'),
    );
    expect(run.stderr).not.toContain('Run the same command again');
  });
});

describe('over ssh:// (the archive)', () => {
  it('sends the archive again over the new connection, which probes for tar again', async () => {
    const ssh = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    cleanups.push(() => ssh.stop());
    const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' })
      .replace(hostKeyLine, ssh.hostKeyLine)
      .replace('sftp://', 'ssh://');
    const first = createProject(config, tenPages());
    expect((await runMain(['deploy'], { cwd: first.root, connect: dialing(ssh) })).exitCode).toBe(
      0,
    );
    const changed: Record<string, string> = {};
    for (const [path, content] of Object.entries(tenPages())) changed[path] = `${content}, v2`;
    const second = createProject(config, changed);
    ssh.faults.dropArchive();
    const probes = ssh.commands().length;

    const run = await runMain(['deploy'], { cwd: second.root, connect: dialing(ssh) });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain('Reconnected. Resuming: 10 files left.');
    // Two connects, each probing for tar, and the archive sent twice: dropped, then whole.
    expect(
      ssh
        .commands()
        .slice(probes)
        .filter((command) => command.includes('tar')),
    ).toHaveLength(4);
    const site = [...ssh.files()].filter(([path]) => path.startsWith('/home/site/'));
    expect(site.map(([path]) => path.slice('/home/site/'.length)).sort()).toEqual(pages);
    for (const [, file] of site) expect(new TextDecoder().decode(file.bytes)).toMatch(/, v2$/);
    // The dropped archive's temp names were removed first, over the new connection.
    expect(temps([...ssh.files().keys()])).toEqual([]);
  });
});

describe('over FTP (the real transport)', () => {
  it('reconnects after a dropped connection: a new pool, the rest sent', async () => {
    const ftp = await createFtpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    cleanups.push(() => ftp.stop());
    const config = [
      'parallel: 1',
      'upload: public_html',
      'targets:',
      '  production:',
      '    server: ftp://deploy@ftp.example.com/site',
      `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      '',
    ].join('\n');
    const project = createProject(config, tenPages());
    // The connect's probe and the lock's note are STORs too: the drop comes a few uploads in.
    ftp.faults.failWrite(6, 'connection-lost');

    const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(ftp) });

    expect(run.exitCode, run.stderr).toBe(0);
    const [, arrived = ''] = /Connection lost after (\d+) of 10 files\./.exec(run.stderr) ?? [];
    expect(Number(arrived)).toBeGreaterThan(0);
    expect(run.stderr).toContain(`Reconnected. Resuming: ${10 - Number(arrived)} files left.`);
    expect(ftp.logins()).toBeGreaterThan(1);
    const site = [...ftp.files().keys()].filter((path) => path.startsWith('/site/'));
    expect(site.map((path) => path.slice('/site/'.length)).sort()).toEqual(pages);
  });
});
