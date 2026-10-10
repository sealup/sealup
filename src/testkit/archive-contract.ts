// The archive's contract suite (0034, spec #41 decision 13): what every ArchiveUpload does, run
// against the memory server and the in-process SSH server (and the OpenSSH container in e2e).
// The executable form of ArchiveUpload's doc comment in contracts: files arrive whole at their
// paths, a path not in the archive is never touched (so a temp name keeps the old file until the
// rename), and a stream that fails leaves the old files in place.

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ArchiveFile,
  ArchiveUpload,
  RemotePath,
  ServerPath,
  Session,
} from '../contracts/index.ts';
import { joinServer, parseRemotePath } from '../paths/index.ts';
import { type ConnectOptions, readText, text } from './session-contract-kit.ts';

/** Problems a test server can inject into an archive's stream. */
export interface ArchiveFaults {
  /** The next archive's connection drops once part of its stream has arrived. */
  dropArchive(): void;
  /** The next archive's `tar` fails at the end: the disk is full (`quota`). */
  failArchive(): void;
  /** The next archive's stream is never read: the server stops taking bytes. */
  stallArchive(): void;
}

/** A server whose sessions carry an archive. */
export interface ArchiveContractServer {
  connect(options?: ConnectOptions): Promise<Session>;
  /** Absent on a real server (the OpenSSH container): the fault tests are left out. */
  readonly faults?: ArchiveFaults;
  stop?(): Promise<void>;
}

/** The archive's tests, against a fresh server per test. */
export function archiveContract(
  name: string,
  factory: () => Promise<ArchiveContractServer>,
  options: { readonly faults: boolean } = { faults: true },
): void {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A server, a session with an archive, the site folder made, and local files to send. */
  const open = async (options: ConnectOptions = {}) => {
    const server = await factory();
    if (server.stop !== undefined) cleanups.push(server.stop.bind(server));
    const session = await server.connect(options);
    cleanups.push(() => session.close());
    const archive = session.archive;
    if (archive === undefined) throw new Error('the session carries no archive');
    const root = joinServer(session.loginFolder, remote('site'));
    await session.mkdir(root);
    const local = mkdtempSync(join(tmpdir(), 'sealup archive '));
    cleanups.push(() => rmSync(local, { recursive: true, force: true }));
    let made = 0;
    /** Local files for the archive: path under root → content. */
    const files = (contents: Readonly<Record<string, string | Uint8Array>>): ArchiveFile[] =>
      Object.entries(contents).map(([path, content]) => {
        const file = join(local, `${made++}.bin`);
        writeFileSync(file, content);
        const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
        return { path: remote(path), file, size };
      });
    const at = (path: string): ServerPath => joinServer(root, remote(path));
    return { server, session, archive, root, files, at, local };
  };

  const send = (
    archive: ArchiveUpload,
    root: ServerPath,
    files: readonly ArchiveFile[],
    onSent: (sent: { files: number; bytes: number }) => void = () => {},
    signal?: AbortSignal,
  ) => archive.send(root, files, { onSent, signal });

  describe(`ArchiveUpload contract: ${name}`, () => {
    it('puts every file, whole, at its path under the root, making the folders it needs', async () => {
      const { session, archive, root, files, at } = await open();
      const big = Uint8Array.from({ length: 300 * 1024 }, (_, i) => (i * 7) % 251);
      await send(
        archive,
        root,
        files({ 'index.html': '<h1>hi</h1>', 'assets/js/app.js': big, 'empty.txt': '' }),
      );
      expect(await readText(session, at('index.html'))).toBe('<h1>hi</h1>');
      const read = await session.read(at('assets/js/app.js'), 1_000_000);
      expect(read.kind === 'found' && Buffer.from(read.bytes).equals(Buffer.from(big))).toBe(true);
      expect(await readText(session, at('empty.txt'))).toBe('');
    });

    it('tells what it passed on after each file, ending at every file and byte', async () => {
      const { archive, root, files } = await open();
      const heard: { files: number; bytes: number }[] = [];
      await send(archive, root, files({ a: 'aaaa', 'b/c': 'cc', d: '' }), (sent) =>
        heard.push({ ...sent }),
      );
      expect(heard.map((sent) => sent.files)).toEqual([1, 2, 3]);
      expect(heard.at(-1)).toEqual({ files: 3, bytes: 6 });
    });

    // R15: the names travel inside the archive only; a name a shell would read stays a name.
    it('keeps names a shell would read as plain files, and nothing else appears', async () => {
      const { session, archive, root, files } = await open();
      const hostile = [
        "a'b.php",
        '$(touch pwned)',
        '-rf',
        '--checkpoint-action=exec=sh',
        '`id`;x',
        'é ü/naïve file.txt',
        `${'long-name-'.repeat(12)}.txt`,
      ];
      await send(archive, root, files(Object.fromEntries(hostile.map((path) => [path, path]))));
      const listed = await session.list(root, 100);
      const names = listed.kind === 'found' ? listed.entries.map((entry) => entry.name) : [];
      expect(names.sort()).toEqual(
        [...new Set(hostile.map((path) => path.split('/')[0] ?? ''))].sort(),
      );
      for (const path of hostile) {
        expect(await readText(session, joinServer(root, remote(path)))).toBe(path);
      }
      const login = await session.list(session.loginFolder, 100);
      expect(login.kind === 'found' && login.entries.map((entry) => entry.name)).not.toContain(
        'pwned',
      );
    });

    it('replaces a file already at a path it carries, and touches no other', async () => {
      const { session, archive, root, files, at } = await open();
      await session.put(text('old'), at('page.html'));
      await session.put(text('kept'), at('other.html'));
      await send(archive, root, files({ 'page.html': 'new' }));
      expect(await readText(session, at('page.html'))).toBe('new');
      expect(await readText(session, at('other.html'))).toBe('kept');
    });

    // R18, as execute uses it: under a temp name the old file stays until the rename.
    it('leaves the old file in place while the new one waits under a temp name', async () => {
      const { session, archive, root, files, at } = await open();
      await session.put(text('old'), at('page.html'));
      await send(archive, root, files({ '.page.html.sealup-0123456789abcdef.tmp': 'new' }));
      expect(await readText(session, at('page.html'))).toBe('old');
      await session.rename(at('.page.html.sealup-0123456789abcdef.tmp'), at('page.html'));
      expect(await readText(session, at('page.html'))).toBe('new');
    });

    // A real server cannot be made to fail on purpose: these need a test server's faults.
    if (options.faults) {
      it('fails with connection-lost when the stream drops, leaving the old files', async () => {
        const { server, archive, root, files } = await open();
        const before = await server.connect();
        cleanups.push(() => before.close());
        await before.put(text('old'), joinServer(root, remote('page.html')));
        need(server).dropArchive();
        const big = randomBytes(512 * 1024);
        const sent = files({
          '.page.html.sealup-0123456789abcdef.tmp': big,
          '.more.sealup-0123456789abcdef.tmp': big,
        });
        await expect(send(archive, root, sent)).rejects.toMatchObject({
          name: 'TransportError',
          code: 'connection-lost',
        });
        const after = await server.connect();
        cleanups.push(() => after.close());
        expect(await readText(after, joinServer(root, remote('page.html')))).toBe('old');
      });

      it("fails with the server's tar: a full disk is quota", async () => {
        const { server, session, archive, root, files, at } = await open();
        await session.put(text('old'), at('page.html'));
        need(server).failArchive();
        await expect(
          send(archive, root, files({ '.page.html.sealup-0123456789abcdef.tmp': 'new' })),
        ).rejects.toMatchObject({ name: 'TransportError', code: 'quota' });
        expect(await readText(session, at('page.html'))).toBe('old');
      });

      it('fails with timeout when the server stops taking bytes', async () => {
        const { server, archive, root, files } = await open({ timeoutMs: 300 });
        need(server).stallArchive();
        // Random, so gzip cannot shrink it below the SSH window: the stream must stall.
        const big = randomBytes(6 * 1024 * 1024);
        await expect(send(archive, root, files({ 'big.bin': big }))).rejects.toMatchObject({
          name: 'TransportError',
          code: 'timeout',
        });
      });
    }

    it('fails with changed when a local file is not the size given', async () => {
      const { archive, root, files } = await open();
      const [file] = files({ 'page.html': 'four' });
      if (file === undefined) throw new Error('no file');
      await expect(send(archive, root, [{ ...file, size: 10 }])).rejects.toMatchObject({
        name: 'TransportError',
        code: 'protocol',
        reason: 'changed',
        path: joinServer(root, remote('page.html')),
      });
    });

    it('stops at once on Ctrl-C (the signal), sending nothing more', async () => {
      const { session, archive, root, files, at } = await open();
      const controller = new AbortController();
      controller.abort();
      await expect(
        send(archive, root, files({ 'page.html': 'new' }), () => {}, controller.signal),
      ).rejects.toMatchObject({ name: 'TransportError' });
      expect(await readText(session, at('page.html'))).toBe('not-found');
    });
  });
}

/** The faults of a server the fault tests run against. */
function need(server: ArchiveContractServer): ArchiveFaults {
  if (server.faults === undefined) throw new Error('archive contract: this server has no faults');
  return server.faults;
}

function remote(name: string): RemotePath {
  const result = parseRemotePath(name);
  if (!result.ok) throw new Error(`archive contract: bad name ${name} (${result.problem})`);
  return result.path;
}
