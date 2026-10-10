// scan's hash cache (spec #41 decision 25): a file whose path, size, mtime and ctime match the
// last scan's is not hashed again. A missing, unreadable, foreign or corrupt cache costs only
// speed. The cache folder is a fresh temp folder in every test, never the user's.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mapping } from '../../src/contracts/index.ts';
import { scanLocal } from '../../src/scan/index.ts';

// SHA-256 of `abc` (FIPS 180-2 appendix B.1) and of `xyz` (sha256sum, GNU coreutils 8.32).
const sha = {
  abc: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  xyz: '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282',
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tempFolder(name: string): string {
  const folder = mkdtempSync(join(tmpdir(), `sealup ${name} `));
  folders.push(folder);
  return folder;
}

/** A day ago: older than any scan in the test, as a built file is by the next deploy. */
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

/** A project whose files were last changed a day ago, uploaded from `dist/`. */
function project(files: Record<string, string>): { root: string; dist: Mapping } {
  const root = tempFolder('project');
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, 'dist', ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    utimesSync(full, yesterday, yesterday);
  }
  const place = { file: join(root, 'sealup.yml'), keyPath: 'upload.dist' };
  const dist: Mapping = {
    kind: 'folder',
    local: join(root, 'dist'),
    remote: '',
    localFromConfig: 'dist',
    place,
  };
  return { root, dist };
}

describe('the hash cache', () => {
  it('hashes no unchanged file on the next scan', async () => {
    const { root, dist } = project({ 'a.txt': 'abc', 'b/c.txt': 'abc' });
    const cache = { folder: tempFolder('cache'), project: join(root, 'sealup.yml') };

    const first = await scanLocal([dist], [], { cache });
    const second = await scanLocal([dist], [], { cache });

    expect(first.hashed).toBe(2);
    expect(second.hashed).toBe(0);
    expect([...second.files.values()].map((file) => [file.size, file.sha256])).toEqual([
      [3, sha.abc],
      [3, sha.abc],
    ]);
  });

  it('hashes again a file changed with the same size', async () => {
    const { root, dist } = project({ 'a.txt': 'abc' });
    const cache = { folder: tempFolder('cache'), project: join(root, 'sealup.yml') };
    await scanLocal([dist], [], { cache });

    writeFileSync(join(root, 'dist', 'a.txt'), 'xyz');
    const second = await scanLocal([dist], [], { cache });

    expect(second.hashed).toBe(1);
    expect([...second.files.values()]).toMatchObject([{ size: 3, sha256: sha.xyz }]);
  });

  it('hashes again a file changed with the same size and its mtime put back', async () => {
    const { root, dist } = project({ 'a.txt': 'abc' });
    const cache = { folder: tempFolder('cache'), project: join(root, 'sealup.yml') };
    await scanLocal([dist], [], { cache });

    // Past the coarsest ctime step (Windows' system clock, about 16 ms): only ctime tells.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const file = join(root, 'dist', 'a.txt');
    writeFileSync(file, 'xyz');
    utimesSync(file, yesterday, yesterday);
    const second = await scanLocal([dist], [], { cache });

    expect(second.hashed).toBe(1);
    expect([...second.files.values()]).toMatchObject([{ size: 3, sha256: sha.xyz }]);
  });

  it('keeps no hash of a file changed in the last two seconds (FAT dates in 2 s steps)', async () => {
    const { root, dist } = project({ 'old.txt': 'abc' });
    writeFileSync(join(root, 'dist', 'new.txt'), 'abc');
    const cache = { folder: tempFolder('cache'), project: join(root, 'sealup.yml') };

    await scanLocal([dist], [], { cache });
    const second = await scanLocal([dist], [], { cache });

    expect(second.hashed).toBe(1);
  });

  it('writes one file in the cache folder, through a temp name, and creates the folder', async () => {
    const { root, dist } = project({ 'a.txt': 'abc' });
    const folder = join(tempFolder('cache'), 'sealup');
    const cache = { folder, project: join(root, 'sealup.yml') };

    await scanLocal([dist], [], { cache });
    await scanLocal([dist], [], { cache });

    expect(readdirSync(folder)).toEqual([expect.stringMatching(/^[0-9a-f]{16}\.json$/)]);
    expect(readdirSync(root)).toEqual(['dist']);
  });

  it('keeps one file per project, each read for its own project only', async () => {
    const one = project({ 'a.txt': 'abc' });
    const two = project({ 'a.txt': 'abc' });
    const folder = tempFolder('cache');

    await scanLocal([one.dist], [], { cache: { folder, project: join(one.root, 'sealup.yml') } });
    await scanLocal([two.dist], [], { cache: { folder, project: join(two.root, 'sealup.yml') } });
    const again = await scanLocal([one.dist], [], {
      cache: { folder, project: join(one.root, 'sealup.yml') },
    });

    expect(readdirSync(folder)).toHaveLength(2);
    expect(again.hashed).toBe(0);
  });

  describe('costs only speed when it is', () => {
    /** The project scanned once, so its cache file exists; that file, and a scan to rerun. */
    async function scannedOnce(): Promise<{
      file: string;
      rescan: () => ReturnType<typeof scanLocal>;
    }> {
      const { root, dist } = project({ 'a.txt': 'abc', 'b.txt': 'abc' });
      const folder = tempFolder('cache');
      const cache = { folder, project: join(root, 'sealup.yml') };
      await scanLocal([dist], [], { cache });
      const [name] = readdirSync(folder);
      if (name === undefined) throw new Error('the first scan wrote no cache file');
      return { file: join(folder, name), rescan: () => scanLocal([dist], [], { cache }) };
    }

    /** The cache file with every hash replaced by `xyz`'s and `edit` applied to the whole. */
    function poisoned(
      file: string,
      edit: (cache: Record<string, unknown>) => void = () => {},
    ): void {
      const cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const files = cache.files as Record<string, string[]>;
      for (const entry of Object.values(files)) entry[3] = sha.xyz;
      edit(cache);
      writeFileSync(file, JSON.stringify(cache));
    }

    it('trusted when whole: a hash it holds is used unread (the control case)', async () => {
      const { file, rescan } = await scannedOnce();
      poisoned(file);

      const again = await rescan();

      expect(again.hashed).toBe(0);
      expect([...again.files.values()].map((entry) => entry.sha256)).toEqual([sha.xyz, sha.xyz]);
    });

    it.each([
      ['missing', (file: string) => rmSync(file)],
      ['empty', (file: string) => writeFileSync(file, '')],
      ['not JSON', (file: string) => writeFileSync(file, '{"format": "sealup hash')],
      ['another format', (file: string) => poisoned(file, (cache) => (cache.format = 'other'))],
      ['another version', (file: string) => poisoned(file, (cache) => (cache.version = 2))],
      [
        "another project's",
        (file: string) => poisoned(file, (cache) => (cache.project = '/elsewhere/sealup.yml')),
      ],
      [
        'holding a bad entry',
        (file: string) =>
          poisoned(file, (cache) => {
            (cache.files as Record<string, unknown>)['/x'] = ['3', '1', '1', 'not a hash'];
          }),
      ],
      [
        'unreadable (a folder in its place)',
        (file: string) => {
          rmSync(file);
          mkdirSync(file);
        },
      ],
    ])('%s', async (_, spoil) => {
      const { file, rescan } = await scannedOnce();
      spoil(file);

      const again = await rescan();

      expect(again.hashed).toBe(2);
      expect([...again.files.values()].map((entry) => entry.sha256)).toEqual([sha.abc, sha.abc]);
    });

    it('unwritable: the scan still ends, with every hash', async () => {
      const { root, dist } = project({ 'a.txt': 'abc' });
      const blocker = join(tempFolder('cache'), 'sealup');
      writeFileSync(blocker, 'a file where the cache folder should be');
      const cache = { folder: blocker, project: join(root, 'sealup.yml') };

      const first = await scanLocal([dist], [], { cache });
      const second = await scanLocal([dist], [], { cache });

      expect(first.hashed).toBe(1);
      expect(second.hashed).toBe(1);
      expect([...second.files.values()]).toMatchObject([{ sha256: sha.abc }]);
    });
  });
});
