// The SSH archive closes every local file it opened, however a send ends: a handle left to the
// garbage collector is an error from Node 26 on (ERR_INVALID_STATE, "A FileHandle object was
// closed during garbage collection"). The file-opening seam, node:fs/promises' open, is wrapped
// to count the handles still open once a send has failed.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveFile, RemotePath, Session } from '../../src/contracts/index.ts';
import { joinServer } from '../../src/paths/index.ts';
import { sshContractServer } from '../sftp-kit.ts';

const tracked = vi.hoisted(() => ({ open: new Set<object>(), opened: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const open = async (...args: Parameters<typeof fs.open>): Promise<FileHandle> => {
    const handle = await fs.open(...args);
    tracked.open.add(handle);
    tracked.opened += 1;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      try {
        await close();
      } finally {
        tracked.open.delete(handle);
      }
    };
    return handle;
  };
  return { ...fs, default: { ...fs, open }, open };
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A server, a session with an archive, and two big local files to send under `site`. */
async function setUp(): Promise<{
  server: Awaited<ReturnType<typeof sshContractServer>>;
  session: Session;
  send(signal?: AbortSignal): Promise<void>;
}> {
  const server = await sshContractServer();
  cleanups.push(() => server.stop());
  const session = await server.connect();
  cleanups.push(() => session.close());
  const root = joinServer(session.loginFolder, 'site' as RemotePath);
  await session.mkdir(root);
  const local = mkdtempSync(join(tmpdir(), 'sealup archive handles '));
  cleanups.push(() => rmSync(local, { recursive: true, force: true }));
  const files: ArchiveFile[] = ['a.bin', 'b.bin'].map((name) => {
    const file = join(local, name);
    writeFileSync(file, randomBytes(2 * 1024 * 1024));
    return { path: name as RemotePath, file, size: 2 * 1024 * 1024 };
  });
  const { archive } = session;
  if (archive === undefined) throw new Error('the session carries no archive');
  return {
    server,
    session,
    send: (signal) => archive.send(root, files, { onSent: () => {}, signal }),
  };
}

describe('the SSH archive closes every local file it opened', () => {
  afterEach(() => {
    tracked.open.clear();
    tracked.opened = 0;
  });

  it('when the connection drops mid-stream', async () => {
    const { server, send } = await setUp();
    server.faults.dropArchive();
    await expect(send()).rejects.toMatchObject({ code: 'connection-lost' });
    expect(tracked.opened).toBeGreaterThan(0);
    await vi.waitFor(() => expect(tracked.open.size).toBe(0));
  });

  it('and opens none when Ctrl-C comes before the channel is open', async () => {
    const { send } = await setUp();
    const controller = new AbortController();
    const sent = send(controller.signal);
    controller.abort();
    await expect(sent).rejects.toMatchObject({ reason: 'interrupted' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tracked.opened).toBe(0);
  });
});
