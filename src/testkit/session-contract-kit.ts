// The Session contract suite's shared parts (decision 0013): the server it connects to, the faults
// a test server can inject, a fresh server and session per test, and the small helpers its tests
// read and write with. The tests themselves are in session-contract.ts and
// session-contract-list-get.ts.

import { afterEach, expect } from 'vitest';
import type { RemotePath, ServerPath, Session, TransportErrorCode } from '../contracts/index.ts';
import { joinServer, parseRemotePath } from '../paths/index.ts';

export interface ConnectOptions {
  /** Per-operation timeout; an operation that takes longer fails with `timeout`. */
  readonly timeoutMs?: number;
}

/** A server the suite can connect to. */
export interface ContractServer {
  connect(options?: ConnectOptions): Promise<Session>;
  /**
   * Puts a symbolic link at `path` pointing at `target`, as a person might have (set-up, not a
   * Session operation): the suite checks that `list` reports it and never follows it.
   */
  seedLink(path: ServerPath, target: string): void | Promise<void>;
  /** Stops the server after each test, when it holds resources (ports, temp folders). */
  stop?(): Promise<void>;
}

/** Problems a test server can inject (spec #1, story 79). */
export interface SessionFaults {
  /** The `nth` put from now (1 = the next one) fails with `code`; `connection-lost` drops it. */
  failWrite(nth: number, code: TransportErrorCode): void;
  /**
   * The `nth` file read from now (`read` or `get`; 1 = the next one) drops the connection
   * part-way, once its first chunk has been sent.
   */
  dropDuringRead(nth: number): void;
  /**
   * The next read of `path` (`read` or `get`) finds the file changed to `bytes` once its size
   * was looked at: a file that grows or shrinks while it is pulled.
   */
  changeDuringRead(path: ServerPath, bytes: Uint8Array): void;
  /** Every later login is refused (`auth`). */
  refuseLogin(): void;
  /** Every later operation takes `ms` longer. */
  slow(ms: number): void;
}

export interface FaultyContractServer extends ContractServer {
  readonly faults: SessionFaults;
}

export type Factory<S extends ContractServer> = () => Promise<S>;

export interface Opened<S extends ContractServer> {
  readonly server: S;
  readonly session: Session;
  /** The ServerPath of a relative name inside the login folder. */
  readonly at: (name: string) => ServerPath;
}

/** A fresh server and session per test, stopped after it. */
export function useServers<S extends ContractServer>(
  factory: Factory<S>,
): () => Promise<Opened<S>> {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return async () => {
    const server = await factory();
    if (server.stop !== undefined) cleanups.push(server.stop.bind(server));
    const session = await server.connect();
    cleanups.push(() => session.close());
    const at = (name: string): ServerPath => joinServer(session.loginFolder, remote(name));
    return { server, session, at };
  };
}

function remote(name: string): RemotePath {
  const result = parseRemotePath(name);
  if (!result.ok) throw new Error(`contract suite: bad name ${name} (${result.problem})`);
  return result.path;
}

export function text(value: string): { bytes: Uint8Array } {
  return { bytes: new TextEncoder().encode(value) };
}

export async function readBytes(session: Session, path: ServerPath): Promise<Uint8Array | string> {
  const result = await session.read(path, 1_000_000);
  return result.kind === 'found' ? Uint8Array.from(result.bytes) : result.kind;
}

export async function readText(
  session: Session,
  path: ServerPath,
  maxBytes = 1_000_000,
): Promise<string> {
  const result = await session.read(path, maxBytes);
  return result.kind === 'found' ? new TextDecoder().decode(result.bytes) : result.kind;
}

export async function expectCode(
  promise: Promise<unknown>,
  code: TransportErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'TransportError', code });
}
