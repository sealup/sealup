// The SSH archive over several streams (decision 0039): a large archive is spread over a few
// exec channels of the one connection, each running the same fixed command, so the server's
// `tar`s create files side by side (a shared host's storage takes ~1.5 ms a file, one after the
// other; ruling 6's measurement). Each file travels once, whatever channel takes it; a channel
// the server refuses leaves its share to the others; one stream's failure fails the archive and
// closes every channel. A small archive stays one stream.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArchiveFile, RemotePath, ServerPath, Session } from '../../src/contracts/index.ts';
import { joinServer } from '../../src/paths/index.ts';
import { createSftpServer, type SftpServer } from '../../src/testkit/index.ts';
import { sshTarget, testSession } from '../sftp-kit.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `count` small local files, `f<i>.txt` under a folder each tenth, holding their own name. */
function localFiles(count: number): ArchiveFile[] {
  const local = mkdtempSync(join(tmpdir(), 'sealup archive streams '));
  cleanups.push(() => rmSync(local, { recursive: true, force: true }));
  return Array.from({ length: count }, (_, i) => {
    const path = `d${i % 10}/f${i}.txt`;
    const file = join(local, `${i}.txt`);
    writeFileSync(file, path);
    return { path: path as RemotePath, file, size: Buffer.byteLength(path) };
  });
}

async function setUp(
  timeoutMs = 30_000,
  before: (server: SftpServer) => void = () => {},
): Promise<{
  server: SftpServer;
  session: Session;
  root: ServerPath;
}> {
  const server = await createSftpServer();
  cleanups.push(() => server.stop());
  before(server);
  const session = await testSession(sshTarget(server, { timeoutMs }));
  const root = joinServer(session.loginFolder, 'site' as RemotePath);
  await session.mkdir(root);
  return { server, session, root };
}

const tarCommands = (server: SftpServer): string[] =>
  server.commands().filter((command) => command.startsWith('tar '));

/** Waits until the server holds no open exec channel, at most 2 s. */
async function execsClosed(server: SftpServer): Promise<number> {
  for (let waited = 0; waited < 2_000 && server.execsOpen() > 0; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return server.execsOpen();
}

describe('the SSH archive over several streams', () => {
  it('spreads 1,000 files over 4 streams of the one command, each file once and whole', async () => {
    const { server, session, root } = await setUp();
    const files = localFiles(1_000);
    const heard: { files: number; bytes: number }[] = [];

    await session.archive?.send(root, files, {
      onSent: (sent) => heard.push({ ...sent }),
      signal: undefined,
    });

    expect(tarCommands(server)).toEqual(Array(4).fill(`tar -xmzf - -C '${root}'`));
    const archives = server.archives();
    expect(archives).toHaveLength(4);
    for (const names of archives) expect(names.length).toBeGreaterThan(0);
    expect(archives.flat().sort()).toEqual(files.map((file) => file.path).sort());
    for (const file of files) {
      const held = server.files().get(`${root}/${file.path}`);
      expect(new TextDecoder().decode(held?.bytes)).toBe(file.path);
    }
    // Progress: one call per file, counting up to every file and byte.
    expect(heard.map((sent) => sent.files)).toEqual(files.map((_, i) => i + 1));
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    expect(heard.at(-1)).toEqual({ files: 1_000, bytes });
    expect(await execsClosed(server)).toBe(0);
  });

  it('keeps a small archive as one stream', async () => {
    const { server, session, root } = await setUp();
    const files = localFiles(150);

    await session.archive?.send(root, files, { onSent: () => {}, signal: undefined });

    expect(tarCommands(server)).toHaveLength(1);
    expect(server.archives()).toEqual([files.map((file) => file.path)]);
  });

  it('sends every file over the channels it gets when the server refuses the others', async () => {
    // Two SFTP channels and the probe's come first: one more is all this host allows.
    const { server, session, root } = await setUp(30_000, (server) =>
      server.faults.refuseChannelsBeyond(4),
    );
    const files = localFiles(1_000);

    await session.archive?.send(root, files, { onSent: () => {}, signal: undefined });

    expect(server.archives()).toHaveLength(1);
    expect(server.archives().flat().sort()).toEqual(files.map((file) => file.path).sort());
  });

  it("fails the whole archive with one stream's tar, and closes every channel", async () => {
    const { server, session, root } = await setUp();
    server.faults.failArchive();

    await expect(
      session.archive?.send(root, localFiles(1_000), { onSent: () => {}, signal: undefined }),
    ).rejects.toMatchObject({ name: 'TransportError', code: 'quota' });
    expect(await execsClosed(server)).toBe(0);
  });

  // The others may finish first (or not, on a loaded machine): the stalled one still fails it.
  it('fails with timeout when one stream stalls, whatever the others do', async () => {
    const { server, session, root } = await setUp(500);
    server.faults.stallArchive();

    await expect(
      session.archive?.send(root, localFiles(1_000), { onSent: () => {}, signal: undefined }),
    ).rejects.toMatchObject({ name: 'TransportError', code: 'timeout' });
    expect(server.archives().length).toBeLessThan(4);
  });

  it('stops every stream on Ctrl-C', async () => {
    const { server, session, root } = await setUp();
    const controller = new AbortController();
    const sent = session.archive?.send(root, localFiles(1_000), {
      onSent: (progress) => {
        if (progress.files === 10) controller.abort();
      },
      signal: controller.signal,
    });

    await expect(sent).rejects.toMatchObject({ name: 'TransportError', reason: 'interrupted' });
    expect(await execsClosed(server)).toBe(0);
  });
});
