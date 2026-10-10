// `ftps://` through the real FTP transport and the in-process FTPS server (R8, R9; spec #41
// decision 8): explicit TLS before the login, the certificate checked or pinned, data connections
// that resume the control's TLS session, and never a user name sent when TLS fails. The CA and
// host-name checks with a trusted certificate are in ftps-ca.test.ts (they change the process's
// default CAs).

import { describe, expect, it } from 'vitest';
import { type ServerPath, TransportError } from '../../src/contracts/index.ts';
import { testCertificates, testServerKey } from '../../src/testkit/index.ts';
import { connectFtp, scanCertificate } from '../../src/transport/index.ts';
import { ftpsTarget, testFtpServer, testFtpSession } from '../ftp-kit.ts';

const { selfSigned, trusted } = testCertificates;
const tls = (cert: string) => ({ key: testServerKey, cert });

/** The TransportError a connect failed with (the test fails when it connects). */
async function connectError(promise: Promise<unknown>): Promise<TransportError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TransportError)) throw new Error(`expected a TransportError: ${error}`);
  return error;
}

const sentUser = (commands: readonly string[]): boolean =>
  commands.some((command) => /^(USER|PASS)\b/.test(command));

describe('ftps:// with a certificate no CA vouches for (R8)', () => {
  it('stops before the user name is sent: the self-signed certificate is not trusted', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem) });
    const error = await connectError(
      connectFtp(ftpsTarget(server, undefined, { parallel: 1 }), { signal: undefined }),
    );
    expect([error.code, error.reason]).toEqual(['tls', 'certificate-untrusted']);
    expect(error.certificate).toMatchObject({
      subject: selfSigned.subject,
      issuer: selfSigned.issuer,
      sha256: selfSigned.sha256,
      validFrom: '2026-10-09T06:29:23.000Z',
      validTo: '2126-09-15T06:29:23.000Z',
    });
    expect(server.commands()).toContain('AUTH TLS');
    expect(sentUser(server.commands())).toBe(false);
  });

  it('logs in when tlsFingerprint pins it: the pin replaces the CA and name checks', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem) });
    const session = await testFtpSession(ftpsTarget(server, selfSigned.sha256));
    expect(session.certificate).toMatchObject({
      subject: selfSigned.subject,
      sha256: selfSigned.sha256,
    });
    const path = `${session.loginFolder}/index.html` as ServerPath;
    await session.put({ bytes: new TextEncoder().encode('hello') }, path);
    expect(await session.read(path, 100)).toMatchObject({ kind: 'found' });
    expect(server.commands().indexOf('AUTH TLS')).toBeLessThan(
      server.commands().findIndex((command) => command.startsWith('USER')),
    );
  });

  it('stops before the user name is sent when the server shows another certificate than the pinned one', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem) });
    const error = await connectError(
      connectFtp(ftpsTarget(server, trusted.sha256, { parallel: 1 }), { signal: undefined }),
    );
    expect([error.code, error.reason]).toEqual(['tls', 'certificate-other']);
    expect(error.certificate?.sha256).toBe(selfSigned.sha256);
    expect(sentUser(server.commands())).toBe(false);
  });

  it('checks every connection of the pool, each before its own login', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem) });
    await testFtpSession(ftpsTarget(server, selfSigned.sha256, { parallel: 4 }));
    const commands = server.commands();
    expect(commands.filter((command) => command === 'AUTH TLS')).toHaveLength(4);
    expect(commands.filter((command) => command.startsWith('USER'))).toHaveLength(4);
  });
});

describe('ftps:// on a server that refuses AUTH TLS (R8)', () => {
  it('stops before the user name is sent, never falling back to plain FTP', async () => {
    const server = await testFtpServer();
    const error = await connectError(
      connectFtp(ftpsTarget(server, selfSigned.sha256, { parallel: 1 }), { signal: undefined }),
    );
    expect([error.code, error.reason]).toEqual(['tls', 'tls-refused']);
    expect(server.commands()).toEqual(['AUTH TLS']);
  });
});

describe('ftps:// data connections', () => {
  it('travel over TLS, each resuming the control connection’s session', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem) });
    const session = await testFtpSession(ftpsTarget(server, selfSigned.sha256, { parallel: 1 }));
    const folder = session.loginFolder;
    for (const name of ['a', 'b', 'c']) {
      await session.put(
        { bytes: new TextEncoder().encode(name) },
        `${folder}/${name}` as ServerPath,
      );
    }
    expect(await session.list(folder, 100)).toMatchObject({ kind: 'found' });
    expect(server.dataTls().length).toBeGreaterThanOrEqual(4);
    expect(new Set(server.dataTls())).toEqual(new Set(['resumed']));
  });

  it('may start a new TLS session when the server shows the pinned certificate again', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem), dataCert: selfSigned.pem });
    const session = await testFtpSession(ftpsTarget(server, selfSigned.sha256, { parallel: 1 }));
    const path = `${session.loginFolder}/index.html` as ServerPath;
    await session.put({ bytes: new TextEncoder().encode('hello') }, path);
    expect(await session.read(path, 100)).toMatchObject({ kind: 'found' });
    // The first one cannot resume the control's session; later ones resume each other's.
    expect(server.dataTls()[0]).toBe('new-session');
  });

  it('are refused when a new TLS session shows another certificate than the pinned one', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem), dataCert: trusted.pem });
    // The connect's own probe (an empty file) is the first transfer: it is refused.
    const error = await connectError(
      connectFtp(ftpsTarget(server, selfSigned.sha256, { parallel: 1 }), { signal: undefined }),
    );
    expect([error.code, error.reason]).toEqual(['tls', 'certificate-other']);
    expect(server.dataAddresses()).toHaveLength(1);
  });

  it('go to the control connection’s address when PASV names another one (R9)', async () => {
    const server = await testFtpServer({
      tls: tls(selfSigned.pem),
      epsv: false,
      pasvHost: '192.0.2.10',
    });
    const session = await testFtpSession(ftpsTarget(server, selfSigned.sha256, { parallel: 1 }));
    const path = `${session.loginFolder}/index.html` as ServerPath;
    await session.put({ bytes: new TextEncoder().encode('hello') }, path);
    expect(await session.read(path, 100)).toMatchObject({ kind: 'found' });
    expect(server.commands()).toContain('PASV');
    expect(server.dataAddresses().length).toBeGreaterThan(0);
    expect(new Set(server.dataAddresses())).toEqual(new Set(['127.0.0.1']));
    expect(new Set(server.dataTls())).toEqual(new Set(['resumed']));
  });
});

describe('the certificate scan (keyscan on ftps://, spec #41 decision 12)', () => {
  const url = (server: { host: string; port: number }) =>
    ({
      protocol: 'ftps',
      user: 'deploy',
      host: server.host,
      port: server.port,
      folder: '/',
    }) as const;
  const options = { signal: undefined, timeoutMs: 10_000 };

  it('shows the certificate and what the normal check says, sending no user name', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem) });
    const scan = await scanCertificate(url(server), options);
    expect(scan).toEqual({
      certificate: {
        subject: selfSigned.subject,
        issuer: selfSigned.issuer,
        validFrom: '2026-10-09T06:29:23.000Z',
        validTo: '2126-09-15T06:29:23.000Z',
        sha256: selfSigned.sha256,
      },
      check: 'untrusted',
    });
    expect(sentUser(server.commands())).toBe(false);
    await server.closed();
  });

  it('fails as connect does when the server refuses AUTH TLS', async () => {
    const server = await testFtpServer();
    const error = await connectError(scanCertificate(url(server), options));
    expect([error.code, error.reason]).toEqual(['tls', 'tls-refused']);
    expect(server.commands()).toEqual(['AUTH TLS']);
  });
});
