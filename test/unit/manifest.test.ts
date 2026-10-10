// manifest: the codec (format 2, format 1 still read, untrusted input, R12) and the store over a
// Session (temp + rename, one file per target folder in the manifest folder, R14).

import { describe, expect, it } from 'vitest';
import {
  type FileRecord,
  type Manifest,
  type RemotePath,
  type ServerPath,
  type Sha256,
  TransportError,
} from '../../src/contracts/index.ts';
import { decode, encode, manifestStore } from '../../src/manifest/index.ts';
import { createMemoryServer } from '../../src/testkit/index.ts';

const hash = 'ab'.repeat(32) as Sha256;
const target = '/home/deploy/www' as ServerPath;
const folder = '/home/deploy/.sealup' as ServerPath;

function manifestOf(
  paths: readonly string[],
  at: ServerPath = target,
  pending: readonly string[] = [],
): Manifest {
  return {
    format: 2,
    folder: at,
    files: new Map<RemotePath, FileRecord>(
      paths.map((path, i) => [path as RemotePath, { size: i, sha256: hash }]),
    ),
    pending: pending as RemotePath[],
  };
}

const temp = 'assets/.app.js.sealup-0123456789abcdef.tmp';

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('manifest codec', () => {
  it('round-trips, names special in JavaScript and spaces included (R11)', () => {
    const manifest = manifestOf(['__proto__', 'constructor', 'my pages/about us.html', 'a/b.js']);
    expect(decode(encode(manifest))).toEqual(manifest);
  });

  it('round-trips the temp names in flight (format 2, decision 0032)', () => {
    const manifest = manifestOf(['a/b.js'], target, [
      temp,
      '.index.html.sealup-fedcba9876543210.tmp',
    ]);
    expect(decode(encode(manifest))).toEqual(manifest);
  });

  it('writes plain JSON with the format first and the pending names last', () => {
    const text = new TextDecoder().decode(encode(manifestOf(['index.html'], target, [temp])));
    expect(Object.keys(JSON.parse(text))).toEqual(['format', 'folder', 'files', 'pending']);
    expect(JSON.parse(text)).toEqual({
      format: 2,
      folder: '/home/deploy/www',
      files: [{ path: 'index.html', size: 0, sha256: hash }],
      pending: [temp],
    });
  });

  it('still reads format 1, as a manifest with no pending names', () => {
    const one = {
      format: 1,
      folder: '/home/deploy/www',
      files: [{ path: 'a', size: 0, sha256: hash }],
    };
    expect(decode(bytes(one))).toEqual(manifestOf(['a']));
  });

  const valid = { format: 2, folder: '/home/site', files: [], pending: [] };
  const one = { format: 1, folder: '/home/site', files: [] };
  const file = { path: 'a.txt', size: 1, sha256: hash };
  it.each([
    ['not JSON', new TextEncoder().encode('{"format":1,')],
    ['a later format', bytes({ ...valid, format: 3 })],
    ['format 1 with pending names', bytes({ ...one, pending: [] })],
    ['format 2 without pending names', bytes({ ...one, format: 2 })],
    ['pending names that are not a list', bytes({ ...valid, pending: temp })],
    ['a pending name that is not a temp name', bytes({ ...valid, pending: ['index.html'] })],
    [
      'a pending name like a temp name in its folder only',
      bytes({ ...valid, pending: [`${temp}/x`] }),
    ],
    ['a pending name leaving the folder', bytes({ ...valid, pending: [`../${temp}`] })],
    [
      'a pending name with a short random part',
      bytes({ ...valid, pending: ['.a.sealup-0123.tmp'] }),
    ],
    ['a pending name twice', bytes({ ...valid, pending: [temp, temp] })],
    ['a pending name that is not text', bytes({ ...valid, pending: [7] })],
    ['a relative folder', bytes({ ...valid, folder: 'home/site' })],
    ['a path leaving the folder', bytes({ ...valid, files: [{ ...file, path: '../x' }] })],
    ['an absolute path', bytes({ ...valid, files: [{ ...file, path: '/etc/passwd' }] })],
    ['a bad hash', bytes({ ...valid, files: [{ ...file, sha256: 'xyz' }] })],
    ['a negative size', bytes({ ...valid, files: [{ ...file, size: -1 }] })],
    ['a path twice', bytes({ ...valid, files: [file, file] })],
    ['files as an object', bytes({ ...valid, files: { 'a.txt': file } })],
    ['an unknown key', bytes({ ...valid, owner: 'x' })],
    ['an unknown key in a record', bytes({ ...valid, files: [{ ...file, mode: 0o777 }] })],
    [
      'a __proto__ key',
      new TextEncoder().encode('{"format":2,"folder":"/a","files":[],"pending":[],"__proto__":{}}'),
    ],
    [
      'a record with a __proto__ key',
      new TextEncoder().encode(
        `{"format":2,"folder":"/a","files":[{"path":"a","size":1,"sha256":"${hash}","__proto__":{}}],"pending":[]}`,
      ),
    ],
    ['a record that is not an object', bytes({ ...valid, files: ['a.txt'] })],
  ])('refuses %s', (_, input) => {
    expect(decode(input)).toBeUndefined();
  });
});

describe('manifestStore over a Session', () => {
  it('reads absent before the first write, then what was written', async () => {
    const server = createMemoryServer();
    const session = await server.connect();
    const store = manifestStore(session, { folder, target });
    expect(await store.read()).toEqual({ kind: 'absent' });

    const manifest = manifestOf(['index.html', 'a/b.js']);
    await store.write(manifest);
    expect(await store.read()).toEqual({ kind: 'found', manifest });
  });

  it('keeps one file per target folder in the manifest folder, and no temp file', async () => {
    const server = createMemoryServer();
    const session = await server.connect();
    await manifestStore(session, { folder, target }).write(manifestOf(['a']));
    const other = '/home/deploy/other' as ServerPath;
    await manifestStore(session, { folder, target: other }).write(manifestOf(['b'], other));

    const names = [...server.files().keys()];
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^\/home\/deploy\/\.sealup\/[a-z0-9-]+\.json$/);
    expect(names[0]).toMatch(/\/home-deploy-(www|other)-[0-9a-f]{8}\.json$/);
  });

  it('creates a nested manifest folder below the login folder', async () => {
    const server = createMemoryServer();
    const session = await server.connect();
    const nested = '/home/deploy/private/state/.sealup' as ServerPath;
    await manifestStore(session, { folder: nested, target }).write(manifestOf(['a']));
    expect(server.folders()).toContain(nested);
  });

  it('calls a manifest that is invalid, too large, or about another folder unusable (R12)', async () => {
    const server = createMemoryServer();
    const session = await server.connect();
    const store = manifestStore(session, { folder, target }, { maxBytes: 200 });
    await store.write(manifestOf(['a']));
    const [path] = server.files().keys();
    if (path === undefined) throw new Error('no manifest written');

    server.seedFile(path, '{"format":1,');
    expect(await store.read()).toEqual({ kind: 'unusable', reason: 'invalid' });
    server.seedFile(path, encode(manifestOf(['a'], '/home/deploy/elsewhere' as ServerPath)));
    expect(await store.read()).toEqual({ kind: 'unusable', reason: 'invalid' });
    server.seedFile(path, encode(manifestOf(['a', 'b', 'c'])));
    expect(await store.read()).toEqual({ kind: 'unusable', reason: 'too-large' });
  });

  it('calls a manifest the server will not let it read unusable (R12)', async () => {
    const server = createMemoryServer();
    const session = await server.connect();
    const store = manifestStore(session, { folder, target });
    await store.write(manifestOf(['a']));
    const [path] = server.files().keys();
    if (path === undefined) throw new Error('no manifest written');
    await session.remove(path as ServerPath);
    server.seedFile(`${path}/inside`, 'a folder where the file was');
    expect(await store.read()).toEqual({ kind: 'unusable', reason: 'unreadable' });

    const refusing = manifestStore(
      {
        ...session,
        read: () =>
          Promise.reject(new TransportError('permission', 'answer', { operation: 'read' })),
      },
      { folder, target },
    );
    expect(await refusing.read()).toEqual({ kind: 'unusable', reason: 'unreadable' });
  });

  it('lets a lost connection through as the server problem it is', async () => {
    const server = createMemoryServer();
    const session = await server.connect();
    await session.close();
    await expect(manifestStore(session, { folder, target }).read()).rejects.toMatchObject({
      code: 'connection-lost',
    });
  });
});
