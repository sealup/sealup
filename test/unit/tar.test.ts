// transport's tar packer (spec #41 decision 14, R5): changed files packed into one gzip tar stream,
// read back with testkit's own tar reader. GNU tar and busybox tar extract it in
// test/e2e/tar.test.ts.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RemotePath, type ServerPath, TransportError } from '../../src/contracts/index.ts';
import { readTar } from '../../src/testkit/index.ts';
import { packTar, type TarEntry } from '../../src/transport/index.ts';

const root = '/home/deploy/www' as ServerPath;
const text = (value: string) => new TextEncoder().encode(value);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

async function pack(entries: readonly TarEntry[]): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of packTar(root, entries) as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

let folder = '';
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'sealup-tar-'));
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** A local file of `size` patterned bytes (not all alike, so gzip cannot hide a misplaced block). */
function localFile(name: string, size: number): { path: string; bytes: Uint8Array } {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + (i >> 9)) % 251);
  const path = join(folder, name);
  writeFileSync(path, bytes);
  return { path, bytes };
}

describe('tar packer', () => {
  it('streams local files from the disk, small, empty and of many blocks', async () => {
    const big = localFile('big.js', 1_500_003);
    const empty = localFile('empty.txt', 0);
    const one = localFile('one-block.txt', 512);
    const archive = await pack(
      [big, empty, one].map(({ path, bytes }, i) => ({
        name: `assets/f${i}` as RemotePath,
        source: { file: path, size: bytes.length },
        mode: 0o640,
        mtime: 1_700_000_000 + i,
      })),
    );
    const read = readTar(archive);
    expect(read.map(({ name, size, mode, mtime }) => ({ name, size, mode, mtime }))).toEqual([
      { name: 'assets/f0', size: 1_500_003, mode: 0o640, mtime: 1_700_000_000 },
      { name: 'assets/f1', size: 0, mode: 0o640, mtime: 1_700_000_001 },
      { name: 'assets/f2', size: 512, mode: 0o640, mtime: 1_700_000_002 },
    ]);
    expect(read.map((file) => Buffer.from(file.bytes).equals(big.bytes))).toEqual([
      true,
      false,
      false,
    ]);
    expect(read[2]?.bytes).toEqual(one.bytes);
  });

  it('streams: entries are read as the archive is, never all at once', async () => {
    // 200 files of 64 KiB of random bytes, which gzip cannot shrink (12.5 MiB of archive).
    const files = range(0, 200).map(() => randomBytes(64 * 1024));
    let pulled = 0;
    function* entries(): Generator<TarEntry> {
      for (const [i, bytes] of files.entries()) {
        pulled++;
        yield { name: `f${i}` as RemotePath, source: { bytes }, mode: 0o644, mtime: 0 };
      }
    }
    const stream = packTar(root, entries());
    for await (const _ of stream) break;
    expect(pulled).toBeGreaterThan(0);
    expect(pulled).toBeLessThan(20);
  });

  it.each([-1, 0.5, 2 ** 33])('refuses a time its header field cannot hold (%s)', async (mtime) => {
    const failure = await pack([
      { name: 'a.txt' as RemotePath, source: { bytes: text('a') }, mode: 0o644, mtime },
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RangeError);
  });

  it('fails with `changed` when a local file is not the size given', async () => {
    const { path } = localFile('grew.txt', 12);
    const failure = await pack([
      { name: 'a/grew.txt' as RemotePath, source: { file: path, size: 10 }, mode: 0o644, mtime: 0 },
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure).toMatchObject({
      code: 'protocol',
      reason: 'changed',
      operation: 'upload',
      path: '/home/deploy/www/a/grew.txt',
    });
  });

  it('fails with the disk error when a local file is missing', async () => {
    const failure = await pack([
      {
        name: 'gone.txt' as RemotePath,
        source: { file: join(folder, 'gone.txt'), size: 1 },
        mode: 0o644,
        mtime: 0,
      },
    ]).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'ENOENT' });
  });

  it('packs a file from bytes with its name, mode and time', async () => {
    const archive = await pack([
      {
        name: 'index.html' as RemotePath,
        source: { bytes: text('<h1>home</h1>\n') },
        mode: 0o644,
        mtime: 1_700_000_000,
      },
    ]);
    expect(readTar(archive)).toEqual([
      {
        name: 'index.html',
        size: 14,
        mode: 0o644,
        mtime: 1_700_000_000,
        bytes: text('<h1>home</h1>\n'),
      },
    ]);
  });

  it('keeps hostile, long and non-ASCII names exactly (PAX headers, R15)', async () => {
    const names = [
      `it's "quoted".txt`,
      'my pages/about us.html',
      '-rf',
      '$(touch pwned)',
      '`id`;rm -rf ~',
      `${'a'.repeat(99)}.x`,
      `deep/${'folder/'.repeat(30)}${'b'.repeat(120)}.html`,
      'café/naïve 日本.txt',
    ];
    const archive = await pack(
      names.map((name, i) => ({
        name: name as RemotePath,
        source: { bytes: text(`file ${i}\n`) },
        mode: 0o644,
        mtime: 1_700_000_000,
      })),
    );
    const read = readTar(archive);
    expect(read.map((file) => file.name)).toEqual(names);
    expect(read.map((file) => new TextDecoder().decode(file.bytes))).toEqual(
      names.map((_, i) => `file ${i}\n`),
    );
  });

  it('counts a PAX record whose length gains a digit (records of 99 to 101, 999 to 1001 bytes)', async () => {
    // A record is `<length> path=<name>\n`; `é` is two bytes, and forces PAX on a short name.
    const lengths = [...range(86, 96), ...range(984, 994)];
    const names = lengths.map((n) => `é${'a'.repeat(n)}`);
    const archive = await pack(
      names.map((name) => ({
        name: name as RemotePath,
        source: { bytes: text('x') },
        mode: 0o644,
        mtime: 0,
      })),
    );
    expect(readTar(archive).map((file) => file.name)).toEqual(names);
  });
});
