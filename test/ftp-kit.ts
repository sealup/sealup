// Glue between the in-process FTP server (testkit) and the real FTP transport, for tests: a Target
// that points at the server, the server as the Session contract suite wants it, and servers and
// sessions stopped after the test.

import { afterEach } from 'vitest';
import type { ServerPath, Session, Target } from '../src/contracts/index.ts';
import { createSecret } from '../src/secret/index.ts';
import {
  createFtpServer,
  type FtpServer,
  testCertificates,
  testServerKey,
} from '../src/testkit/index.ts';
import { connectFtp } from '../src/transport/index.ts';

type FtpServerOptions = Parameters<typeof createFtpServer>[0];

/** Where an FTP server listens and how to log in: in process, or in a container. */
type Login = Pick<FtpServer, 'user' | 'host' | 'port' | 'password'>;

/** A target that logs in to `server` with its password, 4 connections (FTP's default). */
export function ftpTarget(server: Login, overrides: Partial<Target> = {}): Target {
  const password = createSecret('FTP_TEST_PASSWORD', server.password);
  if (!password.ok) throw new Error('test password refused');
  return {
    name: 'production',
    server: {
      protocol: 'ftp',
      user: server.user,
      host: server.host,
      port: server.port,
      folder: '/~/site',
    },
    password: password.secret,
    hostKey: undefined,
    url: undefined,
    uploads: [],
    writes: [],
    pulls: [],
    exclude: [],
    parallel: 4,
    timeoutMs: 30_000,
    manifestFolder: '/~/.sealup',
    allow: new Set(),
    checkServer: false,
    places: {
      server: { file: '/project/sealup.yml', keyPath: 'server', line: 1 },
      password: { file: '/project/sealup.yml', keyPath: 'password', line: 2 },
      hostKey: undefined,
    },
    ...overrides,
  };
}

/** The same target over explicit TLS (`ftps://`), pinned to `tlsFingerprint` when given. */
export function ftpsTarget(
  server: Login,
  tlsFingerprint?: string,
  overrides: Partial<Target> = {},
): Target {
  const plain = ftpTarget(server, overrides);
  return {
    ...plain,
    server: { ...plain.server, protocol: 'ftps' },
    ...(tlsFingerprint === undefined ? {} : { tlsFingerprint }),
  };
}

/** A fresh in-process FTP server, connected through the real transport (contract suites). */
export async function ftpContractServer(
  options: FtpServerOptions = {},
  targetOf: (server: FtpServer, overrides: Partial<Target>) => Target = ftpTarget,
) {
  const server = await createFtpServer(options);
  return {
    server,
    faults: server.faults,
    seedLink: (path: ServerPath, target: string) => server.seedLink(path, target),
    stop: () => server.stop(),
    connect: (connectOptions: { readonly timeoutMs?: number } = {}) =>
      connectFtp(
        targetOf(
          server,
          connectOptions.timeoutMs === undefined ? {} : { timeoutMs: connectOptions.timeoutMs },
        ),
        { signal: undefined },
      ),
  };
}

/**
 * The same over explicit TLS: the server shows the test-only self-signed certificate, and the
 * target pins it (`tlsFingerprint`), as for a shared host whose certificate names another host.
 */
export function ftpsContractServer(options: FtpServerOptions = {}) {
  const { selfSigned } = testCertificates;
  return ftpContractServer(
    { ...options, tls: { key: testServerKey, cert: selfSigned.pem } },
    (server, overrides) => ftpsTarget(server, selfSigned.sha256, overrides),
  );
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An in-process FTP server, stopped once the test ends. */
export async function testFtpServer(options: FtpServerOptions = {}): Promise<FtpServer> {
  const created = await createFtpServer(options);
  cleanups.push(() => created.stop());
  return created;
}

/** A session through the real FTP transport, closed once the test ends. */
export async function testFtpSession(target: Target): Promise<Session> {
  const session = await connectFtp(target, { signal: undefined });
  cleanups.push(() => session.close());
  return session;
}
