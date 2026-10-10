// The tar packer closes the local file it holds however its stream ends: read to the end,
// destroyed by its reader mid-file, left by a reader that stops, or failed by a file that is not
// the size given. A handle left to the garbage collector is an error from Node 26 on. The
// file-opening seam, node:fs/promises' open, is wrapped to count the handles still open.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RemotePath, ServerPath } from '../../src/contracts/index.ts';
import { packTar, type TarEntry } from '../../src/transport/index.ts';

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

const root = '/home/deploy/www' as ServerPath;
const size = 4 * 1024 * 1024;
let folder = '';
let entries: TarEntry[] = [];
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'sealup-tar-handles-'));
  entries = ['a.bin', 'b.bin'].map((name) => {
    const file = join(folder, name);
    // Random, so gzip cannot shrink it: the reader is mid-file after its first chunks.
    writeFileSync(file, randomBytes(size));
    return { name: name as RemotePath, source: { file, size }, mode: 0o644, mtime: 0 };
  });
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));
afterEach(() => {
  tracked.open.clear();
  tracked.opened = 0;
});

describe('tar packer: local files', () => {
  it('are closed once the stream is read to the end', async () => {
    for await (const _ of packTar(root, entries)) {
      // Read it all.
    }
    expect(tracked.opened).toBe(2);
    expect(tracked.open.size).toBe(0);
  });

  it('are closed when the reader destroys the stream mid-file', async () => {
    const stream = packTar(root, entries);
    await new Promise<void>((resolve) => stream.once('data', () => resolve()));
    stream.destroy();
    expect(tracked.opened).toBe(1);
    await vi.waitFor(() => expect(tracked.open.size).toBe(0));
  });

  it('are closed when the reader stops reading mid-file', async () => {
    for await (const _ of packTar(root, entries)) break;
    expect(tracked.opened).toBe(1);
    await vi.waitFor(() => expect(tracked.open.size).toBe(0));
  });

  it('are closed when a file is not the size given', async () => {
    const [first] = entries;
    if (first === undefined || !('file' in first.source)) throw new Error('no file');
    const wrong = { ...first, source: { file: first.source.file, size: size + 1 } };
    const read = async () => {
      for await (const _ of packTar(root, [wrong])) {
        // Read until it fails.
      }
    };
    await expect(read()).rejects.toMatchObject({ reason: 'changed' });
    await vi.waitFor(() => expect(tracked.open.size).toBe(0));
  });
});
