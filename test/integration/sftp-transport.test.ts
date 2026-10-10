// The SFTP transport's own promises, beyond the Session contract: the server's answers as
// TransportError codes, and what connect() does with the host key, the password and the network
// (R7, decision 0023). Its channels and requests in flight are in sftp-channels,
// sftp-channel-loss and sftp-in-flight.test.ts. Driven through transport's connect, against
// the in-process server.

import { describe, expect, it } from 'vitest';
import type { ServerPath } from '../../src/contracts/index.ts';
import { connect } from '../../src/transport/index.ts';
import {
  afterTest,
  atLogin,
  closedPort,
  hostKeyOf,
  kib,
  sftpTarget,
  silentServer,
  slowLink,
  testServer,
  testSession,
} from '../sftp-kit.ts';

describe('server answers mapped to TransportError codes', () => {
  // What the in-process server answers for each (testkit statusFor): a v3 status, and for a
  // full disk a failure in the system's words, as servers without a quota code send it.
  it.each([
    ['no such file', 'not-found'],
    ['permission denied', 'permission'],
    ['"Disk quota exceeded"', 'quota'],
    ['bad message', 'protocol'],
  ] as const)('an upload answered with %s fails with %s', async (_, code) => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp));
    sftp.faults.failWrite(1, code);
    await expect(session.put({ bytes: kib(1) }, atLogin(session, 'a.bin'))).rejects.toMatchObject({
      name: 'TransportError',
      code,
    });
  });
});

describe('connect: the host key before the password (R7)', () => {
  it('logs in with the password once the pinned key matches', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp));
    expect(session.loginFolder).toBe('/home/deploy');
    expect(sftp.logins()).toEqual([{ method: 'password', accepted: true }]);
  });

  it('asks for the pinned key type first, so a server with several keys shows that one', async () => {
    const sftp = await testServer({ keyTypes: ['ed25519', 'rsa'] });
    await testSession(sftpTarget(sftp));
    expect(sftp.logins()).toEqual([{ method: 'password', accepted: true }]);
  });

  it('stops on another key with host-key, naming the key it got; no password is sent', async () => {
    const sftp = await testServer();
    const other = await testServer();
    const target = sftpTarget(sftp, {
      hostKey: hostKeyOf(other.hostKeyLine, other.fingerprint),
    });
    await expect(connect(target, { signal: undefined })).rejects.toMatchObject({
      name: 'TransportError',
      code: 'host-key',
      received: { type: 'ssh-ed25519', fingerprint: sftp.fingerprint },
    });
    expect(sftp.logins()).toEqual([]);
  });

  it('names the type of a key of another kind', async () => {
    const sftp = await testServer({ keyTypes: ['rsa'] });
    const other = await testServer();
    const target = sftpTarget(sftp, {
      hostKey: hostKeyOf(other.hostKeyLine, other.fingerprint),
    });
    await expect(connect(target, { signal: undefined })).rejects.toMatchObject({
      code: 'host-key',
      received: { type: 'ssh-rsa', fingerprint: sftp.fingerprint },
    });
  });

  it('never connects without a pinned key', async () => {
    const sftp = await testServer();
    await expect(
      connect(sftpTarget(sftp, { hostKey: undefined }), { signal: undefined }),
    ).rejects.toMatchObject({ code: 'host-key' });
    expect(sftp.logins()).toEqual([]);
  });
});

describe('connect: a refused login (decision 0023: exit 3, never retried)', () => {
  it('fails with auth after one password attempt, and nothing else', async () => {
    const sftp = await testServer();
    sftp.faults.refuseLogin();
    await expect(connect(sftpTarget(sftp), { signal: undefined })).rejects.toMatchObject({
      code: 'auth',
    });
    expect(sftp.logins()).toEqual([{ method: 'password', accepted: false }]);
  });
});

describe('connect: an unreachable server (exit 5)', () => {
  it('fails with unreachable when the port refuses the connection', async () => {
    const sftp = await testServer();
    const port = await closedPort();
    const target = sftpTarget(sftp);
    await expect(
      connect({ ...target, server: { ...target.server, port } }, { signal: undefined }),
    ).rejects.toMatchObject({ code: 'unreachable', reason: 'refused' });
  });

  it('fails with unreachable when the host name does not exist', async () => {
    const sftp = await testServer();
    const target = sftpTarget(sftp);
    // `.invalid` never resolves (RFC 2606).
    const host = 'no-such-host.invalid';
    await expect(
      connect({ ...target, server: { ...target.server, host } }, { signal: undefined }),
    ).rejects.toMatchObject({ code: 'unreachable', reason: 'no-such-host' });
  });

  it('fails with unreachable when nothing answers within the handshake bound', async () => {
    const sftp = await testServer();
    const silent = await silentServer();
    afterTest(silent.stop);
    const target = sftpTarget(sftp);
    await expect(
      connect(
        { ...target, server: { ...target.server, port: silent.port } },
        { signal: undefined, handshakeTimeoutMs: 300 },
      ),
    ).rejects.toMatchObject({
      code: 'unreachable',
      reason: 'no-answer',
      timeoutMs: 300,
    });
  });

  // `timeout` bounds each SFTP request once logged in, not the handshake: a key exchange over a
  // slow link (or on a loaded CI runner) takes longer than a short per-request timeout.
  it('logs in over a link slower than a short `timeout`, then times out a slow request', async () => {
    const sftp = await testServer();
    const slow = await slowLink(sftp, 300);
    afterTest(slow.stop);
    const target = sftpTarget(sftp, { timeoutMs: 100 });
    const session = await connect(
      { ...target, server: { ...target.server, host: slow.host, port: slow.port } },
      { signal: undefined },
    );
    try {
      sftp.faults.slow(5_000);
      await expect(
        session.put({ bytes: new Uint8Array([1]) }, `${session.loginFolder}/a` as ServerPath),
      ).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await session.close();
    }
  });
});
