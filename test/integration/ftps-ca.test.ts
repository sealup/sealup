// `ftps://` checked like a browser checks (R8, spec #41 decision 8): a certificate a CA vouches
// for must also name the host; `tlsFingerprint` replaces both checks. The test CA is added to
// this process's default CAs (its own file: Vitest runs each file in its own process).

import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ServerPath, TransportError } from '../../src/contracts/index.ts';
import { testCa, testCertificates, testServerKey } from '../../src/testkit/index.ts';
import { connectFtp, scanCertificate } from '../../src/transport/index.ts';
import { createProject, ref, runMain } from '../deploy-kit.ts';
import { ftpsTarget, testFtpServer, testFtpSession } from '../ftp-kit.ts';

const { trusted, otherName, selfSigned } = testCertificates;
const tls = (cert: string) => ({ key: testServerKey, cert });
const defaults = getCACertificates('default');

beforeAll(() => setDefaultCACertificates([...defaults, testCa]));
afterAll(() => setDefaultCACertificates(defaults));

async function connectError(promise: Promise<unknown>): Promise<TransportError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TransportError)) throw new Error(`expected a TransportError: ${error}`);
  return error;
}

describe('ftps:// with a certificate a CA vouches for', () => {
  it('logs in when it names the host, and the data connections pass the same check', async () => {
    const server = await testFtpServer({ tls: tls(trusted.pem) });
    const session = await testFtpSession(ftpsTarget(server, undefined, { parallel: 2 }));
    expect(session.certificate).toMatchObject({
      subject: trusted.subject,
      issuer: trusted.issuer,
      sha256: trusted.sha256,
    });
    const path = `${session.loginFolder}/index.html` as ServerPath;
    await session.put({ bytes: new TextEncoder().encode('hello') }, path);
    expect(await session.read(path, 100)).toMatchObject({ kind: 'found' });
    expect(new Set(server.dataTls())).toEqual(new Set(['resumed']));
  });

  it('stops before the user name is sent when it names another host', async () => {
    const server = await testFtpServer({ tls: tls(otherName.pem) });
    const error = await connectError(
      connectFtp(ftpsTarget(server, undefined, { parallel: 1 }), { signal: undefined }),
    );
    expect([error.code, error.reason]).toEqual(['tls', 'certificate-name']);
    expect(error.certificate?.subject).toBe(otherName.subject);
    expect(server.commands().some((command) => command.startsWith('USER'))).toBe(false);
  });

  it('logs in when it names another host but tlsFingerprint pins it (a shared host)', async () => {
    const server = await testFtpServer({ tls: tls(otherName.pem) });
    const session = await testFtpSession(ftpsTarget(server, otherName.sha256));
    expect(session.certificate?.sha256).toBe(otherName.sha256);
  });

  it('still refuses a self-signed certificate', async () => {
    const server = await testFtpServer({ tls: tls(selfSigned.pem) });
    const error = await connectError(
      connectFtp(ftpsTarget(server, undefined, { parallel: 1 }), { signal: undefined }),
    );
    expect([error.code, error.reason]).toEqual(['tls', 'certificate-untrusted']);
  });

  it.each([
    ['trusted', trusted.pem],
    ['other-name', otherName.pem],
  ])('scans as %s for keyscan', async (check, cert) => {
    const server = await testFtpServer({ tls: tls(cert) });
    const url = { protocol: 'ftps', user: 'deploy', host: server.host, port: server.port } as const;
    const scan = await scanCertificate(
      { ...url, folder: '/' },
      { signal: undefined, timeoutMs: 10_000 },
    );
    expect(scan.check).toBe(check);
  });

  it('refuses a new data session whose certificate fails the check', async () => {
    const server = await testFtpServer({ tls: tls(trusted.pem), dataCert: otherName.pem });
    const error = await connectError(
      connectFtp(ftpsTarget(server, undefined, { parallel: 1 }), { signal: undefined }),
    );
    expect([error.code, error.reason]).toEqual(['tls', 'certificate-name']);
    expect(server.dataAddresses()).toHaveLength(1);
  });
});

describe('keyscan on ftps:// with a trusted certificate (spec #41 decision 12)', () => {
  it('says there is nothing to pin, and asks nothing even on a terminal', async () => {
    const server = await testFtpServer({ tls: tls(trusted.pem) });
    const { root, config } = createProject(
      [
        `server: ftps://deploy@${server.host}:${server.port}/www`,
        `password: ${ref('P')}`,
        'upload: dist',
        '',
      ].join('\n'),
      { 'dist/index.html': 'x' },
    );
    const before = readFileSync(config, 'utf8');
    const run = await runMain(['keyscan', '--no-color'], {
      cwd: root,
      tty: true,
      scanCertificate,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain('  host key    certificate CN=127.0.0.1  verified\n');
    expect(run.stderr).toContain(
      '  ✓ Trusted: a known authority signs it for 127.0.0.1. Nothing to pin.\n',
    );
    expect(readFileSync(config, 'utf8')).toBe(before);
  });
});
