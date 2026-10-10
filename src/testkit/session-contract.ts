// The Session contract suite (decision 0013): the executable form of the Session port's rules in
// contracts. Every Session runs it: the memory fake, the in-process SFTP server, and later the
// containers and the FTP transport. A transport that fails it is wrong, not the suite.
//
// Use from a test file:
//
//   sessionContract('memory', async () => createMemoryServer());
//   sessionFaultContract('memory', async () => createMemoryServer());   // when faults exist
//
// The factory is called once per test and returns a fresh server. The suite works inside the
// session's login folder, which must exist, be empty and be writable.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Capabilities, Session } from '../contracts/index.ts';
import { parseServerPath } from '../paths/index.ts';
import { createFileSecret } from '../secret/index.ts';
import {
  type ContractServer,
  expectCode,
  type Factory,
  type FaultyContractServer,
  readBytes,
  readText,
  text,
  useServers,
} from './session-contract-kit.ts';
import { getContract, getFaultContract, listContract } from './session-contract-list-get.ts';

/**
 * What a real server cannot do, written down where the suite meets it (spec #41 decision 17):
 * each is a server's limit, recorded, never a transport's way out of a rule.
 */
export interface ServerLimits {
  /** `list` leaves out a link whose target is missing (ProFTPD's MLSD). Default false. */
  readonly danglingLinksUnlisted?: boolean;
}

/** Registers the Session contract tests for one kind of server. */
export function sessionContract(
  name: string,
  factory: Factory<ContractServer>,
  limits: ServerLimits = {},
): void {
  describe(`Session contract: ${name}`, () => {
    const open = useServers(factory);

    it('logs in to an absolute login folder and reports how rename replaces', async () => {
      const { session } = await open();
      expect(parseServerPath(session.loginFolder)).toEqual({
        ok: true,
        path: session.loginFolder,
      });
      const replaceModes: readonly Capabilities['replace'][] = [
        'posix-rename',
        'unlink-then-rename',
      ];
      expect(replaceModes).toContain(session.caps.replace);
    });

    describe('put', () => {
      it('writes bytes that read back the same', async () => {
        const { session, at } = await open();
        const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256);
        await session.put({ bytes }, at('data.bin'));
        expect(await readBytes(session, at('data.bin'))).toEqual(bytes);
      });

      it('writes an empty file', async () => {
        const { session, at } = await open();
        await session.put({ bytes: new Uint8Array() }, at('empty.txt'));
        expect(await readText(session, at('empty.txt'))).toBe('');
      });

      it('uploads a local file, from a folder whose name has a space', async () => {
        const { session, at } = await open();
        const folder = mkdtempSync(join(tmpdir(), 'sealup contract '));
        try {
          const file = join(folder, 'index page.html');
          writeFileSync(file, '<h1>hello</h1>');
          await session.put({ file }, at('index page.html'));
          expect(await readText(session, at('index page.html'))).toBe('<h1>hello</h1>');
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
      });

      it('overwrites an existing file, leaving no tail of the old content', async () => {
        const { session, at } = await open();
        await session.put(text('a much longer old content'), at('a.txt'));
        await session.put(text('new'), at('a.txt'));
        expect(await readText(session, at('a.txt'))).toBe('new');
      });

      it('keeps names that are special in JavaScript objects (R11)', async () => {
        const { session, at } = await open();
        for (const name of ['__proto__', 'constructor', 'toString']) {
          await session.put(text(name), at(name));
        }
        expect(await readText(session, at('__proto__'))).toBe('__proto__');
        expect(await readText(session, at('constructor'))).toBe('constructor');
      });

      it('fails with not-found when the folder does not exist', async () => {
        const { session, at } = await open();
        await expectCode(session.put(text('x'), at('missing/a.txt')), 'not-found');
      });

      it('gives a new file the mode asked for (R17), whatever the server would give it', async () => {
        const { session, at } = await open();
        await session.put(text('APP_KEY=base64:fake'), at('.env'), { mode: 0o600 });
        await session.put(text('<?php // config'), at('config.php'), { mode: 0o640 });
        expect(await modeOf(session, '.env')).toBe(0o600);
        expect(await modeOf(session, 'config.php')).toBe(0o640);
        expect(await readText(session, at('.env'))).toBe('APP_KEY=base64:fake');
      });

      it("writes a secret's value, kept in memory, as the file's content (R17)", async () => {
        const { session, at } = await open();
        const made = createFileSecret('APP_ENV', 'APP_ENV=production\nAPP_KEY=fake-é\n');
        if (!made.ok) throw new Error(`contract suite: secret refused (${made.problem})`);
        await session.put({ secret: made.secret }, at('.env'), { mode: 0o600 });
        expect(await readText(session, at('.env'))).toBe('APP_ENV=production\nAPP_KEY=fake-é\n');
      });

      it('gives the mode asked for to a file it overwrites, too', async () => {
        const { session, at } = await open();
        await session.put(text('old, readable by all'), at('.env'));
        await session.put(text('new'), at('.env'), { mode: 0o600 });
        expect(await modeOf(session, '.env')).toBe(0o600);
        expect(await readText(session, at('.env'))).toBe('new');
      });

      it('takes many puts in flight at once', async () => {
        const { session, at } = await open();
        const names = Array.from({ length: 100 }, (_, i) => `f${i}.txt`);
        await Promise.all(names.map((name) => session.put(text(name), at(name))));
        const read = await Promise.all(names.map((name) => readText(session, at(name))));
        expect(read).toEqual(names);
      });
    });

    describe('rename', () => {
      it('moves a file to a new name', async () => {
        const { session, at } = await open();
        await session.put(text('content'), at('.a.txt.tmp-1'));
        await session.rename(at('.a.txt.tmp-1'), at('a.txt'));
        expect(await readText(session, at('a.txt'))).toBe('content');
        expect(await readText(session, at('.a.txt.tmp-1'))).toBe('not-found');
      });

      it('replaces an existing file', async () => {
        const { session, at } = await open();
        await session.put(text('old'), at('a.txt'));
        await session.put(text('new'), at('.a.txt.tmp-2'));
        await session.rename(at('.a.txt.tmp-2'), at('a.txt'));
        expect(await readText(session, at('a.txt'))).toBe('new');
        expect(await readText(session, at('.a.txt.tmp-2'))).toBe('not-found');
      });

      it('moves into another existing folder', async () => {
        const { session, at } = await open();
        await session.mkdir(at('sub'));
        await session.put(text('content'), at('a.txt'));
        await session.rename(at('a.txt'), at('sub/a.txt'));
        expect(await readText(session, at('sub/a.txt'))).toBe('content');
      });

      it('fails with not-found when the file does not exist', async () => {
        const { session, at } = await open();
        await expectCode(session.rename(at('missing.txt'), at('a.txt')), 'not-found');
      });

      it('fails, naming the folder in the way, when a folder holds the name', async () => {
        const { session, at } = await open();
        await session.mkdir(at('docs'));
        await session.put(text('by hand'), at('docs/a.txt'));
        await session.put(text('new'), at('.docs.tmp-3'));
        await expect(session.rename(at('.docs.tmp-3'), at('docs'))).rejects.toMatchObject({
          name: 'TransportError',
          code: 'protocol',
          inTheWay: 'folder',
          path: at('docs'),
        });
        expect(await readText(session, at('docs/a.txt'))).toBe('by hand');
      });
    });

    describe('remove', () => {
      it('deletes a file, and says the server changed', async () => {
        const { session, at } = await open();
        await session.put(text('x'), at('a.txt'));
        expect(await session.remove(at('a.txt'))).toBe(true);
        expect(await readText(session, at('a.txt'))).toBe('not-found');
      });

      it('takes a missing file as done, with nothing changed', async () => {
        const { session, at } = await open();
        await expect(session.remove(at('missing.txt'))).resolves.toBe(false);
        await expect(session.remove(at('missing/a.txt'))).resolves.toBe(false);
      });

      it('takes a folder as no file there: left as it is, nothing changed', async () => {
        const { session, at } = await open();
        await session.mkdir(at('docs'));
        await session.put(text('x'), at('docs/a.txt'));
        await expect(session.remove(at('docs'))).resolves.toBe(false);
        expect(await readText(session, at('docs/a.txt'))).toBe('x');
      });

      it('removes a link, never what it points to (R16)', async () => {
        const { server, session, at } = await open();
        await session.mkdir(at('real'));
        await session.put(text('kept'), at('real/a.txt'));
        await session.put(text('kept too'), at('b.txt'));
        await server.seedLink(at('to-folder'), at('real'));
        await server.seedLink(at('to-file'), at('b.txt'));
        await server.seedLink(at('dangling'), at('missing'));
        for (const name of ['to-folder', 'to-file', 'dangling']) {
          expect(await session.remove(at(name)), name).toBe(true);
          expect(await session.stat(at(name)), name).toEqual({ kind: 'not-found' });
        }
        expect(await readText(session, at('real/a.txt'))).toBe('kept');
        expect(await readText(session, at('b.txt'))).toBe('kept too');
      });
    });

    describe('mkdir', () => {
      it('creates a folder that files can go into, and says the server changed', async () => {
        const { session, at } = await open();
        expect(await session.mkdir(at('assets'))).toBe(true);
        expect(await session.mkdir(at('assets/img'))).toBe(true);
        await session.put(text('x'), at('assets/img/a.png'));
        expect(await readText(session, at('assets/img/a.png'))).toBe('x');
      });

      it('takes an existing folder as done, with nothing changed, keeping what is inside', async () => {
        const { session, at } = await open();
        await session.mkdir(at('assets'));
        await session.put(text('x'), at('assets/a.txt'));
        await expect(session.mkdir(at('assets'))).resolves.toBe(false);
        expect(await readText(session, at('assets/a.txt'))).toBe('x');
      });

      it('fails with not-found when the parent does not exist', async () => {
        const { session, at } = await open();
        await expectCode(session.mkdir(at('missing/sub')), 'not-found');
      });

      it('fails, naming the file in the way, when a file holds the name', async () => {
        const { session, at } = await open();
        await session.put(text('by hand'), at('docs'));
        await expect(session.mkdir(at('docs'))).rejects.toMatchObject({
          name: 'TransportError',
          code: 'protocol',
          inTheWay: 'file',
          path: at('docs'),
        });
        expect(await readText(session, at('docs'))).toBe('by hand');
      });
    });

    describe('rmdir', () => {
      it('removes an empty folder, and says the server changed', async () => {
        const { session, at } = await open();
        await session.mkdir(at('old'));
        expect(await session.rmdir(at('old'))).toBe(true);
        await expectCode(session.put(text('x'), at('old/a.txt')), 'not-found');
      });

      it('takes a missing folder as done, with nothing changed', async () => {
        const { session, at } = await open();
        await expect(session.rmdir(at('missing'))).resolves.toBe(false);
      });

      it('takes a file as no folder there: left as it is, nothing changed', async () => {
        const { session, at } = await open();
        await session.put(text('x'), at('docs'));
        await expect(session.rmdir(at('docs'))).resolves.toBe(false);
        expect(await readText(session, at('docs'))).toBe('x');
      });

      it('leaves a non-empty folder and what is in it, without an error (ruling 11)', async () => {
        const { session, at } = await open();
        await session.mkdir(at('uploads'));
        await session.put(text('kept'), at('uploads/user.jpg'));
        await expect(session.rmdir(at('uploads'))).resolves.toBe(false);
        expect(await readText(session, at('uploads/user.jpg'))).toBe('kept');
      });
    });

    describe('read', () => {
      it('reads a file up to the size limit, and no larger (R21)', async () => {
        const { session, at } = await open();
        await session.put(text('12345'), at('five.txt'));
        expect(await readText(session, at('five.txt'), 5)).toBe('12345');
        expect(await readText(session, at('five.txt'), 4)).toBe('too-large');
      });

      it("gives the file's mode with its bytes, as list gives it (R17)", async () => {
        const { session, at } = await open();
        await session.put(text('APP_KEY=fake'), at('.env'), { mode: 0o600 });
        await session.put(text('<?php'), at('config.php'), { mode: 0o640 });
        const env = await session.read(at('.env'), 100);
        const config = await session.read(at('config.php'), 100);
        expect(env.kind === 'found' && env.mode).toBe(0o600);
        expect(config.kind === 'found' && config.mode).toBe(await modeOf(session, 'config.php'));
      });

      it('says not-found for a missing file or folder', async () => {
        const { session, at } = await open();
        expect(await readText(session, at('missing.txt'))).toBe('not-found');
        expect(await readText(session, at('missing/a.txt'))).toBe('not-found');
      });
    });

    describe('stat', () => {
      it('gives what is at a path without following a link (lstat): a link is a link', async () => {
        const { server, session, at } = await open();
        await session.put(text('x'), at('a.txt'));
        await session.mkdir(at('real'));
        await session.put(text('inside'), at('real/b.txt'));
        await server.seedLink(at('to-folder'), at('real'));
        await server.seedLink(at('to-file'), at('a.txt'));
        await server.seedLink(at('dangling'), at('missing'));
        const kinds = await Promise.all(
          ['a.txt', 'real', 'to-folder', 'to-file', 'dangling'].map(
            async (name) => (await session.stat(at(name))).kind,
          ),
        );
        expect(kinds).toEqual(['file', 'folder', 'link', 'link', 'link']);
        expect(await session.stat(session.loginFolder)).toEqual({ kind: 'folder' });
        const top = parseServerPath('/');
        expect(top.ok && (await session.stat(top.path))).toEqual({ kind: 'folder' });
      });

      it('says not-found for a missing path, a missing parent, or a file as the parent', async () => {
        const { session, at } = await open();
        await session.put(text('x'), at('a.txt'));
        expect(await session.stat(at('missing'))).toEqual({ kind: 'not-found' });
        expect(await session.stat(at('missing/sub'))).toEqual({ kind: 'not-found' });
        expect(await session.stat(at('a.txt/sub'))).toEqual({ kind: 'not-found' });
      });
    });

    listContract(open, limits);
    getContract(open);

    describe('concurrency', () => {
      it('takes many operations of every kind in flight at once', async () => {
        const { session, at } = await open();
        const ids = Array.from({ length: 20 }, (_, i) => i);
        await Promise.all([
          session.put(text('kept'), at('keep.txt')),
          ...ids.flatMap((i) => [
            session.put(text(`old ${i}`), at(`old${i}.txt`)),
            session.put(text(`moved ${i}`), at(`.moved${i}.tmp`)),
            session.mkdir(at(`empty${i}`)),
          ]),
        ]);
        const results = await Promise.all(
          ids.flatMap((i) => [
            session.put(text(`new ${i}`), at(`new${i}.txt`)),
            session.rename(at(`.moved${i}.tmp`), at(`moved${i}.txt`)),
            session.remove(at(`old${i}.txt`)),
            session.mkdir(at(`dir${i}`)),
            session.rmdir(at(`empty${i}`)),
            readText(session, at('keep.txt')),
          ]),
        );
        expect(results).toEqual(
          ids.flatMap(() => [undefined, undefined, true, true, true, 'kept']),
        );
        for (const i of ids) {
          expect(await readText(session, at(`new${i}.txt`))).toBe(`new ${i}`);
          expect(await readText(session, at(`moved${i}.txt`))).toBe(`moved ${i}`);
          expect(await readText(session, at(`.moved${i}.tmp`))).toBe('not-found');
          expect(await readText(session, at(`old${i}.txt`))).toBe('not-found');
          expect(await session.mkdir(at(`dir${i}`))).toBe(false);
          expect(await session.rmdir(at(`empty${i}`))).toBe(false);
        }
      });
    });

    describe('close', () => {
      it('makes later operations fail with connection-lost; closing twice is fine', async () => {
        const { session, at } = await open();
        await session.close();
        await expect(session.close()).resolves.toBeUndefined();
        await expectCode(session.put(text('x'), at('a.txt')), 'connection-lost');
        await expectCode(session.read(at('a.txt'), 10), 'connection-lost');
      });

      it('leaves what arrived for the next session', async () => {
        const { server, session, at } = await open();
        await session.put(text('x'), at('a.txt'));
        await session.close();
        const next = await server.connect();
        try {
          expect(await readText(next, at('a.txt'))).toBe('x');
        } finally {
          await next.close();
        }
      });
    });
  });
}

/** Registers the fault-injection tests: the server's faults show up as the right codes. */
export function sessionFaultContract(name: string, factory: Factory<FaultyContractServer>): void {
  describe(`Session faults: ${name}`, () => {
    const open = useServers(factory);

    it('a refused login fails connect with auth', async () => {
      const { server } = await open();
      server.faults.refuseLogin();
      await expectCode(server.connect(), 'auth');
    });

    it('the nth write fails with the injected code; the others arrive', async () => {
      const { server, session, at } = await open();
      server.faults.failWrite(2, 'quota');
      await session.put(text('1'), at('1.txt'));
      await expectCode(session.put(text('2'), at('2.txt')), 'quota');
      await session.put(text('3'), at('3.txt'));
      expect(await readText(session, at('1.txt'))).toBe('1');
      expect(await readText(session, at('3.txt'))).toBe('3');
    });

    it('counts writes in the order they were started, with many in flight', async () => {
      const { server, session, at } = await open();
      server.faults.failWrite(3, 'permission');
      const results = await Promise.allSettled(
        ['1', '2', '3', '4'].map((n) => session.put(text(n), at(`${n}.txt`))),
      );
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);
    });

    it('a dropped connection fails that write and every later operation', async () => {
      const { server, session, at } = await open();
      server.faults.failWrite(1, 'connection-lost');
      await expectCode(session.put(text('1'), at('1.txt')), 'connection-lost');
      await expectCode(session.mkdir(at('sub')), 'connection-lost');
    });

    it('a dropped connection fails every operation waiting or in flight, and every later one', async () => {
      const { server, session, at } = await open();
      server.faults.failWrite(1, 'connection-lost');
      // More than `parallel` (64 by default): some wait for a slot, the others are in flight.
      const names = Array.from({ length: 100 }, (_, i) => `${i}.txt`);
      const results = await Promise.allSettled(
        names.map((name) => session.put(text(name), at(name))),
      );
      for (const result of results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { name: 'TransportError', code: 'connection-lost' },
        });
      }
      await expectCode(session.read(at('0.txt'), 10), 'connection-lost');
    });

    it('a slow operation still completes within the timeout', async () => {
      const { server, at } = await open();
      server.faults.slow(30);
      const session = await server.connect({ timeoutMs: 2_000 });
      try {
        const started = performance.now();
        await session.put(text('x'), at('a.txt'));
        expect(performance.now() - started).toBeGreaterThanOrEqual(25);
      } finally {
        await session.close();
      }
    });

    it('an operation slower than the timeout fails with timeout', async () => {
      const { server, at } = await open();
      const session = await server.connect({ timeoutMs: 50 });
      try {
        server.faults.slow(5_000);
        await expectCode(session.put(text('x'), at('a.txt')), 'timeout');
      } finally {
        await session.close();
      }
    });

    getFaultContract(open);
  });
}

/** The permission bits of a file in the login folder, as `list` gives them (R17's mode). */
async function modeOf(session: Session, name: string): Promise<number | string> {
  const listed = await session.list(session.loginFolder, 1_000);
  if (listed.kind !== 'found') return listed.kind;
  const entry = listed.entries.find((found) => found.name === name);
  return entry === undefined ? 'missing' : entry.mode & 0o777;
}
