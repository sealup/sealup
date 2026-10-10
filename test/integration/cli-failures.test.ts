// `sealup deploy` through main() (spec #1, seam 2) when a run stops part-way (ticket 08): every
// error ends with a state line (what changed, whether a rerun is safe) and its docs link; Ctrl-C
// exits 130; a stuck operation times out; no stack trace without --debug.

import { afterEach, describe, expect, it } from 'vitest';
import type { Connect, Session } from '../../src/contracts/index.ts';
import { canaries, createMemoryServer, createSftpServer } from '../../src/testkit/index.ts';
import { createProject, hostKeyLine, onlyOnce, productionConfig, runMain } from '../deploy-kit.ts';
import { dialing, silentServer } from '../sftp-kit.ts';

const site = {
  'public_html/a.html': 'a',
  'public_html/b.html': 'b',
  'public_html/c.html': 'c',
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The last lines of the output: from the blank line before the state line to the end. */
function tail(stderr: string): string[] {
  const lines = stderr.trimEnd().split('\n');
  return lines.slice(lines.lastIndexOf('') + 1);
}

describe('sealup deploy: a run that stops part-way', () => {
  it('times out a stuck operation (timeout: 1s): exit 1, the state, the docs link', async () => {
    const server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    cleanups.push(() => server.stop());
    const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }).replace(
      hostKeyLine,
      server.hostKeyLine,
    );
    const project = createProject(`timeout: 1s\n${config}`, site);
    // The second upload: the lock's note (decision 0031) is the first put. The server is not
    // reached again, so the reconnect's tries (spec #41 decision 20) fail.
    server.faults.failWrite(3, 'timeout');

    const run = await runMain(['deploy'], {
      cwd: project.root,
      connect: onlyOnce(dialing(server)),
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('✗ Upload stopped: ssh.example.com stopped answering.');
    expect(run.stderr).toContain('raise timeout in sealup.yml');
    expect(tail(run.stderr)).toEqual([
      '    production now has 2 of 3 new files. Run the same command again to finish.',
      '    sealup recorded what arrived, so the rerun sends only the 1 missing file.',
      '    Until then the site may serve a mix of old and new files.',
      '    More: sealup.dev/e/timeout',
    ]);
  });

  it('exits 1, not 5, when the connection drops after the first change', async () => {
    const project = createProject(productionConfig(), site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    // The connection drops during the second upload: the uploads in flight with it fail too, and
    // the manifest cannot be written. The target folder was made, so the server changed. The
    // lock's note (decision 0031) is the first put. The connection does not come back: the
    // reconnect's tries (spec #41 decision 20) fail.
    server.faults.failWrite(3, 'connection-lost');

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
      connect: onlyOnce(() => server.connect()),
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('✗ Upload stopped: the connection to ssh.example.com was lost.');
    expect(tail(run.stderr)).toEqual([
      '    production now has 0 of 3 new files. Run the same command again to finish.',
      '    sealup could not record what arrived, so the rerun sends all 3 files again.',
      '    Until then the site may serve a mix of old and new files.',
      '    More: sealup.dev/e/connection-lost',
    ]);
  });

  it('stops on Ctrl-C: no new transfer, what arrived recorded, exit 130', async () => {
    const project = createProject(`parallel: 1\n${productionConfig()}`, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const controller = new AbortController();
    // Ctrl-C while the first file is on its way.
    const connect: Connect = async () => {
      const session = await server.connect();
      const pressing: Session = {
        ...session,
        put: async (source, to) => {
          // An upload: the lock's note (decision 0031) goes to the manifest folder first.
          if (to.startsWith('/home/site/')) controller.abort();
          await session.put(source, to);
        },
      };
      return pressing;
    };

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
      connect,
      signal: controller.signal,
    });

    expect(run.exitCode).toBe(130);
    expect(run.stderr).toContain('✗ Stopped: sealup was interrupted (Ctrl-C).');
    expect(tail(run.stderr)).toEqual([
      '    production now has 1 of 3 new files. Run the same command again to finish.',
      '    sealup recorded what arrived, so the rerun sends only the 2 missing files.',
      '    Until then the site may serve a mix of old and new files.',
      '    More: sealup.dev/e/interrupted',
    ]);
  });
});

describe('sealup deploy: Ctrl-C while connecting', () => {
  it('stops the handshake at once: exit 130, nothing changed', async () => {
    const silent = await silentServer();
    cleanups.push(() => silent.stop());
    const project = createProject(productionConfig(), site);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const started = performance.now();
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
      connect: dialing(silent),
      signal: controller.signal,
    });

    // The handshake would wait for `timeout` (30 s) otherwise.
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(run.exitCode).toBe(130);
    expect(tail(run.stderr)).toEqual([
      '    Nothing was changed on production.',
      '    More: sealup.dev/e/interrupted',
    ]);
  });
});

// Windows cannot hold such a name (`\` separates, control characters are refused), so this runs
// on the Linux CI legs; the wording of every reason is in the report unit tests.
describe.runIf(process.platform !== 'win32')(
  'sealup deploy: a local name no server path can hold',
  () => {
    it('stops before connecting with exit 6, naming the file (escaped), no stack trace', async () => {
      const project = createProject(productionConfig(), {
        ...site,
        'public_html/notes\nold.txt': 'x',
      });
      let connected = false;

      const run = await runMain(['deploy'], {
        cwd: project.root,
        env: { PROD_PASSWORD: 'pw-for-tests' },
        connect: async () => {
          connected = true;
          throw new Error('must not connect');
        },
      });

      expect(connected).toBe(false);
      expect(run.exitCode).toBe(6);
      expect(run.stderr).toContain(
        '✗ public_html/notes\\x0aold.txt cannot be sent as it is named.',
      );
      expect(run.stderr).not.toMatch(/^\s+at /m);
      expect(tail(run.stderr)).toEqual([
        '    sealup did not connect. Nothing was changed on production.',
        '    More: sealup.dev/e/bad-local-name',
      ]);
    });
  },
);

describe('sealup deploy: an error sealup did not expect', () => {
  const failing: Connect = async () => {
    throw new Error('boom: an error with no words');
  };

  it('ends with a state line and its docs link, and no stack trace', async () => {
    const project = createProject(productionConfig(), site);

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
      connect: failing,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('✗ sealup stopped on an error it did not expect.');
    expect(run.stderr).not.toContain('boom');
    expect(run.stderr).not.toMatch(/^\s+at /m);
    expect(tail(run.stderr)).toEqual([
      '    Nothing was changed on production.',
      '    More: sealup.dev/e/internal-error',
    ]);
  });

  it('shows the stack with --debug', async () => {
    const project = createProject(productionConfig(), site);

    const run = await runMain(['deploy', '--debug'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
      connect: failing,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Error: boom: an error with no words');
    expect(run.stderr).toMatch(/^\s+at /m);
  });
});
