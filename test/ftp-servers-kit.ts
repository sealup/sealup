// The FTP servers shared hosts run, in Docker containers, for the end-to-end tests (spec #41
// decision 17): Pure-FTPd, ProFTPD and vsftpd, built from test/e2e/ftp/Dockerfile and started by
// its start.sh. User `deploy` logs in with the password the test gives and is locked in its login
// folder, so the session sees it as `/`. With `tls`, the server demands explicit TLS and shows the
// TEST-ONLY self-signed certificate of src/testkit/tls-certificates.ts. What the server holds is
// read inside the container, never through sealup's transport (openssh-kit.ts's `containerFiles`).
//
// Passive mode needs the data ports published on the same numbers the server names: each
// container gets its own range, picked at random and tried again if Docker finds it taken.
//
// Child processes live here, in test/, because src/ may not start any (R5).

import { connect as dial, Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { repoRoot } from '../scripts/gates.ts';
import type { Target } from '../src/contracts/index.ts';
import {
  canaries,
  type ServerLimits,
  sessionContract,
  testCertificates,
  testServerKey,
} from '../src/testkit/index.ts';
import { connect } from '../src/transport/index.ts';
import { ref } from './deploy-kit.ts';
import { ftpsTarget, ftpTarget } from './ftp-kit.ts';
import { type ContainerFiles, containerFiles, docker } from './openssh-kit.ts';

export type FtpServerKind = 'pure-ftpd' | 'proftpd' | 'vsftpd';

const home = '/home/deploy';
const passivePorts = 16;

export interface FtpContainer extends ContainerFiles {
  readonly kind: FtpServerKind;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** Whether it demands explicit TLS (`ftps://`). */
  readonly tls: boolean;
  /**
   * The log of every command and reply, where the server keeps one (ProFTPD, vsftpd). ProFTPD
   * writes a command's line once the command is done: an AUTH TLS whose handshake the client cut
   * short never gets one. `tls`: ProFTPD's TLS log instead, which notes each AUTH TLS as it starts.
   */
  log(which?: 'commands' | 'tls'): Promise<string>;
  /**
   * Resolves once the server runs no session process, only its listener (within 10 s): every
   * session has ended, so its logs hold all it will ever write.
   */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export interface FtpContainerOptions {
  readonly password: string;
  /** Explicit TLS required, with the test-only self-signed certificate; else plain FTP only. */
  readonly tls: boolean;
  /** An address the PASV reply names instead of the server's own (R9). */
  readonly pasvAddress?: string;
  /** EPSV refused, so the client must use PASV (R9). ProFTPD and vsftpd only. */
  readonly noEpsv?: boolean;
}

/** The image of each server, built once per run (Docker caches the layers). */
const built = new Map<FtpServerKind, Promise<unknown>>();

function imageOf(kind: FtpServerKind): Promise<string> {
  const image = `sealup-e2e-${kind}`;
  let building = built.get(kind);
  if (building === undefined) {
    building = docker([
      'build',
      '--quiet',
      '--target',
      kind,
      '--tag',
      image,
      join(repoRoot, 'test', 'e2e', 'ftp'),
    ]);
    built.set(kind, building);
  }
  return building.then(() => image);
}

/** Starts a server, sets the password, waits for its `220` greeting. */
async function startFtpContainer(
  kind: FtpServerKind,
  options: FtpContainerOptions,
): Promise<FtpContainer> {
  if (options.noEpsv === true && kind === 'pure-ftpd') {
    throw new Error('Pure-FTPd cannot refuse EPSV');
  }
  const image = await imageOf(kind);
  const id = await runWithPassivePorts(kind, image, options);
  try {
    // The password goes on chpasswd's stdin, never in an argument list.
    await docker(['exec', '--interactive', id, 'chpasswd'], `deploy:${options.password}\n`);
    const published = (await docker(['port', id, '21/tcp'])).stdout.trim().split('\n')[0] ?? '';
    const port = Number(published.slice(published.lastIndexOf(':') + 1));
    await waitForGreeting('127.0.0.1', port);
    const logFile = kind === 'vsftpd' ? '/var/log/vsftpd.log' : '/var/log/proftpd/commands.log';
    return {
      kind,
      host: '127.0.0.1',
      port,
      user: 'deploy',
      password: options.password,
      tls: options.tls,
      ...containerFiles(id, home, (path) => `${home}${path === '/' ? '' : path}`),
      async log(which = 'commands') {
        if (kind === 'pure-ftpd') throw new Error('Pure-FTPd keeps no command log here');
        if (which === 'tls' && kind !== 'proftpd') throw new Error('only ProFTPD keeps a TLS log');
        const file = which === 'tls' ? '/var/log/proftpd/tls.log' : logFile;
        return (await docker(['exec', id, 'cat', file])).stdout;
      },
      async idle() {
        // Each session is a process of the server's own name, beside the one that listens.
        const count = async () =>
          Number(
            (
              await docker([
                'exec',
                id,
                'sh',
                '-c',
                'grep -lx -- "$1" /proc/[0-9]*/comm 2>/dev/null | wc -l',
                'sh',
                kind,
              ])
            ).stdout.trim(),
          );
        const deadline = Date.now() + 10_000;
        while ((await count()) > 1) {
          if (Date.now() > deadline) throw new Error(`${kind} still runs a session after 10 s`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      async stop() {
        await docker(['rm', '--force', id]);
      },
    };
  } catch (error) {
    await docker(['rm', '--force', id]).catch(() => undefined);
    throw error;
  }
}

/** `docker run` with a random passive range, tried again when a port of it is taken. */
async function runWithPassivePorts(
  kind: FtpServerKind,
  image: string,
  options: FtpContainerOptions,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    // Below the ephemeral ports of Linux (32768 up) and Windows (49152 up), where a client's own
    // socket could hold one.
    const low = 20_000 + Math.floor(Math.random() * 750) * passivePorts;
    const high = low + passivePorts - 1;
    const env: Record<string, string> = {
      FTP_TLS: options.tls ? 'yes' : 'no',
      PASV_MIN: String(low),
      PASV_MAX: String(high),
      ...(options.tls ? { TLS_PEM: `${testServerKey}${testCertificates.selfSigned.pem}` } : {}),
      ...(options.pasvAddress === undefined ? {} : { PASV_ADDRESS: options.pasvAddress }),
      ...(options.noEpsv === true ? { NO_EPSV: 'yes' } : {}),
    };
    try {
      const run = await docker([
        'run',
        '--detach',
        '--rm',
        // An init as PID 1: vsftpd, run as PID 1, dies (SIGSEGV) once its first session ends.
        '--init',
        '--publish',
        '127.0.0.1::21',
        '--publish',
        `127.0.0.1:${low}-${high}:${low}-${high}`,
        // Pure-FTPd keeps these two capabilities for its sessions; without them it exits at once.
        ...(kind === 'pure-ftpd' ? ['--cap-add', 'DAC_READ_SEARCH', '--cap-add', 'SYS_NICE'] : []),
        ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
        image,
      ]);
      return run.stdout.trim();
    } catch (error) {
      const taken = /already allocated|address already in use|ports are not available/i;
      if (attempt >= 5 || !(error instanceof Error) || !taken.test(error.message)) throw error;
    }
  }
}

/** Waits until the server sends its `220` greeting (Docker's port proxy accepts before it does). */
async function waitForGreeting(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = dial({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(2_000, () => done(false));
      socket.once('data', (data) => done(data.toString('latin1').startsWith('220')));
      socket.once('error', () => done(false));
      socket.once('close', () => done(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the FTP server on ${host}:${port} did not greet within 30 s`);
}

/**
 * A target that logs in to the container: `ftps://` pinned to the test certificate when it
 * demands TLS (as for a shared host whose certificate names another host), else `ftp://`.
 */
export function containerTarget(server: FtpContainer, overrides: Partial<Target> = {}): Target {
  return server.tls
    ? ftpsTarget(server, testCertificates.selfSigned.sha256, overrides)
    : ftpTarget(server, overrides);
}

/** The address R9's PASV replies name instead of the server's (TEST-NET-1: never routed). */
export const otherAddress = '192.0.2.10';

/**
 * A `sealup.yml` for the container, `upload: public_html` into `~/site`: `ftps://` pinned to the
 * test certificate when it demands TLS, else `ftp://`. `more`: lines to add.
 */
export function ftpsDeployConfig(server: FtpContainer, ...more: string[]): string {
  return [
    `server: ${server.tls ? 'ftps' : 'ftp'}://deploy@${server.host}:${server.port}/~/site`,
    `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
    ...(server.tls ? [`tlsFingerprint: ${testCertificates.selfSigned.sha256}`] : []),
    'upload: public_html',
    ...more,
    '',
  ].join('\n');
}

/**
 * Runs `work` and gives the host of every TCP connection this process opened meanwhile (R9's
 * test: no data connection may go to the address a PASV reply names).
 */
export async function dialedHosts<T>(
  work: () => Promise<T>,
): Promise<{ readonly run: T; readonly hosts: readonly string[] }> {
  const hosts: string[] = [];
  const original = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    const [first, second] = args;
    const host =
      typeof first === 'object' && first !== null && 'host' in first
        ? String(first.host)
        : typeof second === 'string'
          ? second
          : 'localhost';
    hosts.push(host);
    return Reflect.apply(original, this, args);
  } as typeof original;
  try {
    return { run: await work(), hosts };
  } finally {
    Socket.prototype.connect = original;
  }
}

/**
 * A server for the tests of the enclosing describe block: started before them, stopped after,
 * logging in with the canary password (so every output is under the leak test).
 */
export function useFtpContainer(
  kind: FtpServerKind,
  options: Omit<FtpContainerOptions, 'password'>,
): () => FtpContainer {
  let server: FtpContainer | undefined;
  beforeAll(async () => {
    server = await startFtpContainer(kind, {
      password: canaries.SEALUP_CANARY_PASSWORD,
      ...options,
    });
  });
  afterAll(async () => {
    await server?.stop();
  });
  return () => {
    if (server === undefined) throw new Error(`the ${kind} container did not start`);
    return server;
  };
}

/**
 * The Session contract suite over FTPS on one server (seam 2), pinned to the test certificate.
 * Each test starts from an empty login folder on the same container. `limits`: what the server
 * cannot do, written down.
 */
export function ftpsContractOn(server: () => FtpContainer, limits: ServerLimits = {}): void {
  sessionContract(
    'FTPS (container)',
    async () => {
      await server().clear();
      return {
        seedLink: (path, target) => server().seedLink(path, target),
        connect: (options = {}) =>
          connect(
            containerTarget(
              server(),
              options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
            ),
            { signal: undefined },
          ),
      };
    },
    limits,
  );
}
