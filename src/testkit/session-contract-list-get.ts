// The Session contract suite, part two: `list` and `get`, what `pull` and lane B's full mirror
// build on (spec sealup/sealup#24, decision 5). Registered by sessionContract and
// sessionFaultContract (session-contract.ts), so every Session runs them.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEntry } from '../contracts/index.ts';
import {
  type ContractServer,
  expectCode,
  type FaultyContractServer,
  type Opened,
  text,
} from './session-contract-kit.ts';

type Open<S extends ContractServer> = () => Promise<Opened<S>>;

/** Whole seconds since 1970, by this machine's clock. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A server's clock may differ from this machine's (a container's VM): this much is allowed. */
const clockSlackSeconds = 60;

function byName(entries: readonly ServerEntry[]): ServerEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function listContract(
  open: Open<ContractServer>,
  limits: { readonly danglingLinksUnlisted?: boolean } = {},
): void {
  describe('list', () => {
    it('gives the files and folders of one folder, with their facts, not what is inside them', async () => {
      const { session, at } = await open();
      const before = nowSeconds();
      await session.put(text('12345'), at('five.txt'));
      await session.mkdir(at('img'));
      await session.put(text('x'), at('img/deep.png'));
      const after = nowSeconds();
      const listed = await session.list(session.loginFolder, 10);
      expect(listed.kind).toBe('found');
      const entries = listed.kind === 'found' ? byName(listed.entries) : [];
      expect(entries).toEqual([
        { name: 'five.txt', kind: 'file', size: 5, mtime: expect.any(Number), mode: 0o644 },
        {
          name: 'img',
          kind: 'folder',
          size: expect.any(Number),
          mtime: expect.any(Number),
          mode: expect.any(Number),
        },
      ]);
      // A folder may inherit its parent's setgid bit (0o2000), as the container's home does.
      expect((entries[1]?.mode ?? 0) & 0o777).toBe(0o755);
      for (const { mtime } of entries) {
        expect(Number.isInteger(mtime)).toBe(true);
        expect(mtime).toBeGreaterThanOrEqual(before - clockSlackSeconds);
        expect(mtime).toBeLessThanOrEqual(after + clockSlackSeconds);
      }
    });

    it('gives an empty folder as found, with no entries', async () => {
      const { session, at } = await open();
      await session.mkdir(at('empty'));
      expect(await session.list(at('empty'), 10)).toEqual({ kind: 'found', entries: [] });
    });

    it('says not-found for a missing folder or a missing parent', async () => {
      const { session, at } = await open();
      expect(await session.list(at('missing'), 10)).toEqual({ kind: 'not-found' });
      expect(await session.list(at('missing/sub'), 10)).toEqual({ kind: 'not-found' });
    });

    it('fails, naming the file in the way, when a file holds the name', async () => {
      const { session, at } = await open();
      await session.put(text('x'), at('a.txt'));
      await expect(session.list(at('a.txt'), 10)).rejects.toMatchObject({
        name: 'TransportError',
        code: 'protocol',
        inTheWay: 'file',
        path: at('a.txt'),
      });
    });

    it('gives up to maxEntries entries, and says too-many beyond (R21)', async () => {
      const { session, at } = await open();
      await session.mkdir(at('up'));
      const names = Array.from({ length: 5 }, (_, i) => `f${i}.jpg`);
      await Promise.all(names.map((name) => session.put(text(name), at(`up/${name}`))));
      const listed = await session.list(at('up'), 5);
      expect(listed.kind === 'found' && byName(listed.entries).map((e) => e.name)).toEqual(names);
      expect(await session.list(at('up'), 4)).toEqual({ kind: 'too-many' });
    });

    it('gives names as they are: spaces, dots, and names special in JavaScript objects (R11)', async () => {
      const { session, at } = await open();
      const names = ['.htaccess', '__proto__', 'constructor', 'my photo.jpg', 'été.txt'];
      for (const name of names) await session.put(text(name), at(name));
      const listed = await session.list(session.loginFolder, 10);
      expect(listed.kind === 'found' && byName(listed.entries).map((e) => e.name)).toEqual(
        [...names].sort(),
      );
    });

    it('reports a link as a link, never following it', async () => {
      const { server, session, at } = await open();
      await session.mkdir(at('real'));
      await session.put(text('x'), at('real/a.txt'));
      await server.seedLink(at('to-folder'), at('real'));
      await server.seedLink(at('dangling'), at('missing'));
      const listed = await session.list(session.loginFolder, 10);
      const entries = listed.kind === 'found' ? byName(listed.entries) : [];
      expect(entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
        // Never as anything but a link; left out only where the server's listing omits it.
        ...(limits.danglingLinksUnlisted === true ? [] : [{ name: 'dangling', kind: 'link' }]),
        { name: 'real', kind: 'folder' },
        { name: 'to-folder', kind: 'link' },
      ]);
    });
  });
}

/** A fresh local folder per call, removed after the test. */
function useLocalFolders(): () => string {
  const made: string[] = [];
  afterEach(() => {
    for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  return () => {
    const folder = mkdtempSync(join(tmpdir(), 'sealup get '));
    made.push(folder);
    return folder;
  };
}

/** Bytes in a pattern that shows a chunk written at the wrong place. */
const pattern = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 7 + (i >> 10)) % 251);

/** Byte for byte, as `toEqual` checks, without its seconds per megabyte. */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length, 'length').toBe(expected.length);
  const first = expected.findIndex((byte, i) => actual[i] !== byte);
  expect(first, 'first byte that differs').toBe(-1);
}

export function getContract(open: Open<ContractServer>): void {
  describe('get', () => {
    const localFolder = useLocalFolders();

    it('downloads a file of several chunks into a new local file, byte for byte', async () => {
      const { session, at } = await open();
      const bytes = pattern(100_000);
      await session.put({ bytes }, at('photo.jpg'));
      const to = join(localFolder(), 'photo.jpg');
      await session.get(at('photo.jpg'), to, bytes.length);
      expectSameBytes(new Uint8Array(readFileSync(to)), bytes);
    });

    it('downloads an empty file', async () => {
      const { session, at } = await open();
      await session.put({ bytes: new Uint8Array() }, at('empty.txt'));
      const to = join(localFolder(), 'empty.txt');
      await session.get(at('empty.txt'), to, 0);
      expect(readFileSync(to).length).toBe(0);
    });

    it('fails with not-found for a missing file, creating nothing here', async () => {
      const { session, at } = await open();
      const folder = localFolder();
      await expectCode(session.get(at('missing.jpg'), join(folder, 'a.jpg'), 3), 'not-found');
      await expectCode(session.get(at('missing/a.jpg'), join(folder, 'a.jpg'), 3), 'not-found');
      expect(readdirSync(folder)).toEqual([]);
    });

    it('fails, naming the folder in the way, for a folder, creating nothing here', async () => {
      const { session, at } = await open();
      await session.mkdir(at('img'));
      const folder = localFolder();
      await expect(session.get(at('img'), join(folder, 'img'), 0)).rejects.toMatchObject({
        name: 'TransportError',
        code: 'protocol',
        inTheWay: 'folder',
        path: at('img'),
      });
      expect(readdirSync(folder)).toEqual([]);
    });

    it('never replaces a local file: one already there fails, and is left as it is', async () => {
      const { session, at } = await open();
      await session.put(text('server'), at('a.txt'));
      const to = join(localFolder(), 'a.txt');
      writeFileSync(to, 'mine');
      await expect(session.get(at('a.txt'), to, 6)).rejects.toThrow();
      expect(readFileSync(to, 'utf8')).toBe('mine');
    });

    it('fails with changed when the file is longer or shorter than the size given, leaving nothing here', async () => {
      const { session, at } = await open();
      await session.put({ bytes: pattern(40_000) }, at('a.jpg'));
      const folder = localFolder();
      for (const size of [39_999, 40_001, 0]) {
        await expect(session.get(at('a.jpg'), join(folder, 'a.jpg'), size)).rejects.toMatchObject({
          name: 'TransportError',
          code: 'protocol',
          reason: 'changed',
          path: at('a.jpg'),
        });
      }
      expect(readdirSync(folder)).toEqual([]);
    });

    it('takes many downloads in flight at once', async () => {
      const { session, at } = await open();
      const names = Array.from({ length: 30 }, (_, i) => `f${i}.txt`);
      await Promise.all(names.map((name) => session.put(text(name), at(name))));
      const folder = localFolder();
      await Promise.all(
        names.map((name) => session.get(at(name), join(folder, name), name.length)),
      );
      for (const name of names) expect(readFileSync(join(folder, name), 'utf8')).toBe(name);
    });
  });
}

export function getFaultContract(open: Open<FaultyContractServer>): void {
  describe('get', () => {
    const localFolder = useLocalFolders();

    it.each([
      ['grows', 100_001],
      ['shrinks', 99_999],
    ])(
      'fails with changed when the file %s once its size was looked at, leaving nothing here',
      async (_, length) => {
        const { server, session, at } = await open();
        await session.put({ bytes: pattern(100_000) }, at('a.jpg'));
        server.faults.changeDuringRead(at('a.jpg'), pattern(length));
        const folder = localFolder();
        await expect(
          session.get(at('a.jpg'), join(folder, 'a.jpg'), 100_000),
        ).rejects.toMatchObject({
          name: 'TransportError',
          code: 'protocol',
          reason: 'changed',
          path: at('a.jpg'),
        });
        expect(readdirSync(folder)).toEqual([]);
      },
    );

    it('a connection dropped mid-download fails it, leaves nothing here, and fails every later operation', async () => {
      const { server, session, at } = await open();
      await session.put({ bytes: pattern(100_000) }, at('a.jpg'));
      server.faults.dropDuringRead(1);
      const folder = localFolder();
      await expectCode(session.get(at('a.jpg'), join(folder, 'a.jpg'), 100_000), 'connection-lost');
      expect(readdirSync(folder)).toEqual([]);
      await expectCode(session.list(session.loginFolder, 10), 'connection-lost');
    });

    it('a slow download still completes within the timeout', async () => {
      const { server, at } = await open();
      const session = await server.connect({ timeoutMs: 2_000 });
      try {
        await session.put({ bytes: pattern(100_000) }, at('a.jpg'));
        server.faults.slow(30);
        const to = join(localFolder(), 'a.jpg');
        await session.get(at('a.jpg'), to, 100_000);
        expectSameBytes(new Uint8Array(readFileSync(to)), pattern(100_000));
      } finally {
        await session.close();
      }
    });

    it('a download slower than the timeout fails with timeout, leaving nothing here', async () => {
      const { server, session: seeding, at } = await open();
      // Put by the session with the usual timeout: 50 ms is the download's bound, not the put's.
      await seeding.put(text('x'), at('a.txt'));
      const session = await server.connect({ timeoutMs: 50 });
      try {
        server.faults.slow(5_000);
        const folder = localFolder();
        await expectCode(session.get(at('a.txt'), join(folder, 'a.txt'), 1), 'timeout');
        expect(readdirSync(folder)).toEqual([]);
      } finally {
        await session.close();
      }
    });
  });
}
