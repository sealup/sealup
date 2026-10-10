// The SFTP transport's requests in flight: at most `parallel` across all channels, each file
// pipelined up to its channel's share (spec sealup/sealup#15 decision 1). Driven through
// transport's connect, against the in-process server.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterTest, atLogin, kib, sftpTarget, testServer, testSession } from '../sftp-kit.ts';

/** A fresh local folder, removed once the test ends. */
function localFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'sealup-get-'));
  afterTest(async () => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

/** Byte for byte, as `toEqual` checks, without its seconds per megabyte. */
function expectSameBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(actual?.length, 'length').toBe(expected.length);
  const first = expected.findIndex((byte, i) => actual?.[i] !== byte);
  expect(first, 'first byte that differs').toBe(-1);
}

describe('SFTP requests in flight (`parallel` requests across all channels)', () => {
  it('keeps at most `parallel` requests in flight across all files', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 4 }));
    sftp.faults.slow(50);
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.bin`);
    await Promise.all(
      names.map((name) => session.put({ bytes: kib(100) }, atLogin(session, name))),
    );
    expect(sftp.mostInFlight()).toBe(4);
    expect(sftp.files().get(atLogin(session, 'f9.bin'))?.size).toBe(100 * 1024);
  });

  it('pipelines the chunks of one large file up to `parallel` requests on one channel', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 64 }), 1);
    // No answer until 64 requests are held, then a quiet 100 ms: the client has sent all it may
    // before the first answer comes back, on any machine (a wall-clock delay flaked under load).
    sftp.faults.holdData(64);
    // 65 chunks of 31 KiB (src/transport/session.ts): one more than `parallel`, so a client that
    // sent them all at once would show 65, and one that pipelined less would show under 64.
    const bytes = kib(65 * 31);
    await session.put({ bytes }, atLogin(session, 'big.bin'));
    expect(sftp.mostInFlight()).toBe(64);
    expectSameBytes(sftp.files().get(atLogin(session, 'big.bin'))?.bytes, bytes);
  });

  // A file's handle belongs to one channel, so one file gets that channel's share of `parallel`.
  it('pipelines one large file up to its channel share: 64 over 4 channels is 16', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 64 }), 4);
    sftp.faults.holdData(16);
    // 17 chunks of 31 KiB: one more than the share, so a client that ignored it would show 17.
    const bytes = kib(17 * 31);
    await session.put({ bytes }, atLogin(session, 'big.bin'));
    expect(sftp.mostInFlight()).toBe(16);
    expectSameBytes(sftp.files().get(atLogin(session, 'big.bin'))?.bytes, bytes);
  });

  // get holds a chunk's slot until the chunk is on the disk, so the requests in flight are also
  // the most chunks in memory.
  it('downloads one large file pipelined up to `parallel` requests on one channel', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 64 }), 1);
    // 65 chunks of 31 KiB: one more than `parallel`, as for put.
    const bytes = kib(65 * 31);
    sftp.seedFile(atLogin(session, 'big.bin'), bytes);
    sftp.faults.holdData(64);
    const to = join(localFolder(), 'big.bin');
    await session.get(atLogin(session, 'big.bin'), to, bytes.length);
    expect(sftp.mostInFlight()).toBe(64);
    expectSameBytes(new Uint8Array(readFileSync(to)), bytes);
  });

  it('downloads one large file pipelined up to its channel share: 64 over 4 channels is 16', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 64 }), 4);
    const bytes = kib(17 * 31);
    sftp.seedFile(atLogin(session, 'big.bin'), bytes);
    sftp.faults.holdData(16);
    const to = join(localFolder(), 'big.bin');
    await session.get(atLogin(session, 'big.bin'), to, bytes.length);
    expect(sftp.mostInFlight()).toBe(16);
    expectSameBytes(new Uint8Array(readFileSync(to)), bytes);
  });

  it('splits `parallel` over the channels and keeps all of it in use', async () => {
    const sftp = await testServer();
    // 10 over 4 channels: 3, 3, 2 and 2 requests.
    const session = await testSession(sftpTarget(sftp, { parallel: 10 }), 4);
    sftp.faults.slow(50);
    const names = Array.from({ length: 30 }, (_, i) => `f${i}.bin`);
    await Promise.all(
      names.map((name) => session.put({ bytes: kib(100) }, atLogin(session, name))),
    );
    expect(sftp.mostInFlight()).toBe(10);
    for (const name of names)
      expect(sftp.files().get(atLogin(session, name))?.size).toBe(100 * 1024);
  });
});
