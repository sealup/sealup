// Glue between the in-process SFTP server (testkit) and the real transport, for tests: a Target
// that points at the server, a Connect that dials it while the config names another host, the
// server as the Session contract suite wants it, and servers and sessions stopped after the test.

import { createServer, connect as netConnect, type Socket } from 'node:net';
import { afterEach } from 'vitest';
import type {
  Connect,
  HostKey,
  ScanHostKey,
  ServerPath,
  ServerUrl,
  Session,
  Target,
} from '../src/contracts/index.ts';
import { createSecret } from '../src/secret/index.ts';
import { createSftpServer, type SftpServer } from '../src/testkit/index.ts';
import { connect, scanHostKey } from '../src/transport/index.ts';

/** The pinned key for a public key line (`<type> <base64>`) and its known fingerprint. */
export function hostKeyOf(line: string, fingerprint: string): HostKey {
  const [type = '', key = ''] = line.split(' ');
  return { type, key, fingerprint };
}

/** What a target needs to know of a server: the in-process one, or the OpenSSH container. */
type Reachable = Pick<
  SftpServer,
  'user' | 'host' | 'port' | 'password' | 'hostKeyLine' | 'fingerprint'
>;

/** A target that logs in to `server` with its password and pins its host key. */
export function sftpTarget(server: Reachable, overrides: Partial<Target> = {}): Target {
  const password = createSecret('SFTP_TEST_PASSWORD', server.password);
  if (!password.ok) throw new Error('test password refused');
  return {
    name: 'production',
    server: {
      protocol: 'sftp',
      user: server.user,
      host: server.host,
      port: server.port,
      folder: '/~/site',
    },
    password: password.secret,
    hostKey: hostKeyOf(server.hostKeyLine, server.fingerprint),
    url: undefined,
    uploads: [],
    writes: [],
    pulls: [],
    exclude: [],
    parallel: 64,
    timeoutMs: 30_000,
    manifestFolder: '/~/.sealup',
    allow: new Set(),
    checkServer: false,
    places: {
      server: { file: '/project/sealup.yml', keyPath: 'server', line: 1 },
      password: { file: '/project/sealup.yml', keyPath: 'password', line: 2 },
      hostKey: { file: '/project/sealup.yml', keyPath: 'hostKey', line: 3 },
    },
    ...overrides,
  };
}

/**
 * The real transport's connect, dialling `server` whatever host and port the target names (the
 * goldens print the config's `ssh.example.com:22`; the server listens on 127.0.0.1).
 */
export function dialing(
  server: { readonly host: string; readonly port: number },
  extra: { readonly handshakeTimeoutMs?: number } = {},
): Connect {
  return (target, options) =>
    connect(
      { ...target, server: { ...target.server, host: server.host, port: server.port } },
      { ...options, ...extra },
    );
}

/**
 * A TCP proxy to `server` that holds each connection for `ms` before passing bytes either way:
 * a slow link, or a loaded machine, as the SSH handshake sees it.
 */
export async function slowLink(
  server: { readonly host: string; readonly port: number },
  ms: number,
): Promise<{ readonly host: string; readonly port: number; stop(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const proxy = createServer((socket) => {
    sockets.add(socket);
    socket.pause();
    setTimeout(() => {
      const upstream = netConnect(server.port, server.host);
      sockets.add(upstream);
      socket.pipe(upstream).on('error', () => socket.destroy());
      upstream.pipe(socket).on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
    }, ms);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    host: '127.0.0.1',
    port: (proxy.address() as { port: number }).port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Runs `stop` once the test ends (servers, sessions, proxies), the last one started first. */
export function afterTest(stop: () => Promise<void>): void {
  cleanups.push(stop);
}

/** An in-process SFTP server, stopped once the test ends. */
export async function testServer(
  options: Parameters<typeof createSftpServer>[0] = {},
): Promise<SftpServer> {
  const created = await createSftpServer(options);
  afterTest(() => created.stop());
  return created;
}

/** A session through the real transport's connect, closed once the test ends. */
export async function testSession(
  target: Target,
  channels?: number,
  handshakeTimeoutMs?: number,
): Promise<Session> {
  const session = await connect(target, {
    signal: undefined,
    ...(channels === undefined ? {} : { channels }),
    ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
  });
  afterTest(() => session.close());
  return session;
}

/** `n` KiB of bytes in a pattern that shows a chunk written at the wrong place. */
export const kib = (n: number): Uint8Array =>
  Uint8Array.from({ length: n * 1024 }, (_, i) => i % 251);

/** `name` in the session's login folder. */
export const atLogin = (session: Session, name: string): ServerPath =>
  `${session.loginFolder}/${name}` as ServerPath;

/** A fresh in-process SFTP server, connected through the real transport (contract suites). */
export async function sftpContractServer() {
  const server = await createSftpServer();
  return {
    server,
    faults: server.faults,
    seedLink: (path: ServerPath, target: string) => server.seedLink(path, target),
    stop: () => server.stop(),
    connect: (options: { readonly timeoutMs?: number } = {}) =>
      connect(
        sftpTarget(server, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        {
          signal: undefined,
        },
      ),
  };
}

/**
 * A fresh in-process server reached as `ssh://` through the real transport: its sessions carry
 * the archive, extracted by the server's exec channel (the archive's contract suite).
 */
export async function sshContractServer() {
  const server = await createSftpServer();
  return {
    server,
    faults: server.faults,
    stop: () => server.stop(),
    connect: (options: { readonly timeoutMs?: number } = {}) =>
      connect(
        sshTarget(server, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        { signal: undefined },
      ),
  };
}

/** sftpTarget's target on `ssh://`: SFTP plus a shell, for the archive (0034). */
export function sshTarget(server: Reachable, overrides: Partial<Target> = {}): Target {
  const target = sftpTarget(server, overrides);
  return { ...target, server: { ...target.server, protocol: 'ssh' } };
}

/** The real transport's host-key scan, dialling `server` whatever host and port the URL names. */
export function scanDialing(server: { readonly host: string; readonly port: number }): ScanHostKey {
  return (url, options) => scanHostKey({ ...url, host: server.host, port: server.port }, options);
}

/** The server URL of `server` (the in-process one, or the container), for a host-key scan. */
export function serverUrlOf(server: Pick<SftpServer, 'user' | 'host' | 'port'>): ServerUrl {
  return { protocol: 'sftp', user: server.user, host: server.host, port: server.port, folder: '/' };
}

/** A fresh in-process SFTP server, scanned through the real transport (the scan's contract). */
export async function sftpScanServer() {
  const server = await createSftpServer();
  return {
    hostKeyLine: server.hostKeyLine,
    fingerprint: server.fingerprint,
    logins: () => server.logins(),
    closed: () => server.closed(),
    stop: () => server.stop(),
    scan: (options: { readonly signal?: AbortSignal } = {}) =>
      scanHostKey(serverUrlOf(server), { signal: options.signal, timeoutMs: 30_000 }),
  };
}

/** A port on 127.0.0.1 that nothing listens on (bound, then closed): connecting is refused. */
export async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * A server that accepts connections and never says a word (an SSH handshake that hangs), or says
 * only `greeting` and then waits, as an FTP server does with its `220` line.
 */
export async function silentServer(greeting?: string): Promise<{
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => {
    sockets.add(socket);
    if (greeting !== undefined) socket.write(greeting);
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  return {
    host: '127.0.0.1',
    port: (silent.address() as { port: number }).port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    },
  };
}
