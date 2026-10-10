// The archive's probe after login on `ssh://` (0034 point 5, decision 0039): one fixed command
// that answers with a marker only when the shell finds both `tar` and `gzip` (`tar -z` needs
// it). An account whose every command runs an SFTP server (OpenSSH's ForceCommand) answers no
// marker and exits 0 once its stdin ends: no archive, and no wait for the timeout. A server that
// never answers costs one `timeout`, and its channel is closed.

import { describe, expect, it } from 'vitest';
import { createSftpServer, type SftpServer } from '../../src/testkit/index.ts';
import { afterTest, sshTarget, testSession } from '../sftp-kit.ts';

type Shell = NonNullable<Parameters<typeof createSftpServer>[0]>['shell'];

async function serverWith(shell: Shell): Promise<SftpServer> {
  const server = await createSftpServer(shell === undefined ? {} : { shell });
  afterTest(() => server.stop());
  return server;
}

/** Waits until the server holds no open exec channel (the probe's is closed), at most 2 s. */
async function execsClosed(server: SftpServer): Promise<number> {
  for (let waited = 0; waited < 2_000 && server.execsOpen() > 0; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return server.execsOpen();
}

describe("the archive's probe on ssh://", () => {
  it('offers the archive when the shell finds tar and gzip, with one fixed command', async () => {
    const server = await serverWith('tar');
    const session = await testSession(sshTarget(server));

    expect(session.archive).toBeDefined();
    expect(server.commands()).toEqual([
      'command -v tar >/dev/null && command -v gzip >/dev/null && echo sealup-archive-ok',
    ]);
    expect(await execsClosed(server)).toBe(0);
  });

  it.each([
    ['no tar', 'no-tar'],
    ['tar but no gzip', 'no-gzip'],
    ['no shell at all', 'no-shell'],
  ] as const)('offers no archive on a server with %s', async (_, shell) => {
    const server = await serverWith(shell);
    const session = await testSession(sshTarget(server));

    expect(session.archive).toBeUndefined();
    expect(await execsClosed(server)).toBe(0);
  });

  // ForceCommand sftp-server: the exec channel opens, and an SFTP server reads its stdin. It
  // exits 0 once stdin ends, so exit 0 alone is no answer: only the marker is.
  it('offers no archive on a forced-SFTP account, and does not wait for the timeout', async () => {
    const server = await serverWith('sftp-server');
    const started = Date.now();
    const session = await testSession(sshTarget(server, { timeoutMs: 20_000 }));

    expect(session.archive).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await execsClosed(server)).toBe(0);
  });

  it('gives up after the timeout on a server that never answers, and closes the channel', async () => {
    const server = await serverWith('silent');
    const session = await testSession(sshTarget(server, { timeoutMs: 500 }));

    expect(session.archive).toBeUndefined();
    expect(await execsClosed(server)).toBe(0);
  });
});
