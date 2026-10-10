// The SFTP transport's host-key scan beyond its contract (spec #24 decision 6): the line it shows
// is the one a deploy then pins, a saved key's type is asked for first, and a server it cannot
// reach fails as connect does before login.

import { describe, expect, it } from 'vitest';
import { connect, scanHostKey } from '../../src/transport/index.ts';
import { closedPort, hostKeyOf, serverUrlOf, sftpTarget, testServer } from '../sftp-kit.ts';

const options = { signal: undefined, timeoutMs: 30_000 };

describe('host-key scan over SFTP', () => {
  it('shows the line a deploy then pins: connect logs in with it', async () => {
    const server = await testServer();
    const shown = await scanHostKey(serverUrlOf(server), options);
    const session = await connect(
      sftpTarget(server, { hostKey: hostKeyOf(shown.line, shown.fingerprint) }),
      { signal: undefined },
    );
    await session.close();
    expect(server.logins()).toEqual([{ method: 'password', accepted: true }]);
  });

  it("asks for a saved key's type first, so a server with several keys shows that one", async () => {
    const server = await testServer({ keyTypes: ['ed25519', 'rsa'] });
    const url = serverUrlOf(server);
    expect((await scanHostKey(url, options)).type).toBe('ssh-ed25519');
    const rsa = await scanHostKey(url, { ...options, type: 'ssh-rsa' });
    expect(rsa.type).toBe('ssh-rsa');
    expect(rsa.line.startsWith('ssh-rsa AAAA')).toBe(true);
  });

  it('fails as connect does before login when nothing listens: unreachable, refused', async () => {
    const port = await closedPort();
    const url = { protocol: 'sftp', user: 'deploy', host: '127.0.0.1', port, folder: '/' } as const;
    await expect(scanHostKey(url, options)).rejects.toMatchObject({
      name: 'TransportError',
      code: 'unreachable',
      reason: 'refused',
    });
  });
});
