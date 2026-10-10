// The host-key scan's contract (spec #24 decision 6, R7): the executable form of ScanHostKey's
// rules in contracts. Every server that offers a scan runs it: the memory fake and the
// in-process SFTP server through the real transport.
//
// Use from a test file:
//
//   hostKeyScanContract('memory', async () => { const s = createMemoryServer(); return {
//     scan: (options) => s.scanHostKey(serverUrl, options), ...s } });
//
// The factory is called once per test and returns a fresh server.

import { afterEach, describe, expect, it } from 'vitest';
import type { ScannedHostKey } from '../contracts/index.ts';

/** A server whose host key the suite scans. */
export interface ScanServer {
  /** Scans the server: the port under test, given its signal and timeout. */
  scan(options?: { readonly signal?: AbortSignal }): Promise<ScannedHostKey>;
  /** The key the server holds, as an OpenSSH line (`<type> <base64>`), and its fingerprint. */
  readonly hostKeyLine: string;
  readonly fingerprint: string;
  /** Every authentication attempt the server saw, in order. */
  logins(): readonly unknown[];
  /** Resolves once no connection to the server is open: what it saw is all it will see. */
  closed(): Promise<void>;
  stop?(): Promise<void>;
}

/** Registers the host-key scan tests for one kind of server. */
export function hostKeyScanContract(name: string, factory: () => Promise<ScanServer>): void {
  describe(`Host-key scan contract: ${name}`, () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const stop of stops.splice(0)) await stop();
    });
    const open = async (): Promise<ScanServer> => {
      const server = await factory();
      if (server.stop !== undefined) stops.push(server.stop.bind(server));
      return server;
    };

    it("shows the server's key: its OpenSSH line, its type and its fingerprint", async () => {
      const server = await open();
      const shown = await server.scan();
      expect(shown).toEqual({
        type: server.hostKeyLine.split(' ')[0],
        fingerprint: server.fingerprint,
        line: server.hostKeyLine,
      });
    });

    it('tries no authentication method, so no credential can be sent (R7)', async () => {
      const server = await open();
      await server.scan();
      await server.scan();
      await server.closed();
      expect(server.logins()).toEqual([]);
    });

    it('stops at once on an aborted signal (Ctrl-C), before any key is shown', async () => {
      const server = await open();
      const controller = new AbortController();
      controller.abort();
      await expect(server.scan({ signal: controller.signal })).rejects.toMatchObject({
        name: 'TransportError',
        code: 'unreachable',
        reason: 'interrupted',
      });
    });
  });
}
