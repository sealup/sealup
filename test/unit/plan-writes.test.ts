// plan() with files written from a secret (spec #24 decision 9, owner ruling 8), pure: table
// tests, then property tests on random trees. A write path is never deleted, even one an old
// manifest recorded; an unchanged one counts as unchanged.

import { describe, expect, it } from 'vitest';
import type {
  FileRecord,
  LocalFile,
  Mapping,
  PlanInput,
  RemotePath,
  SecretFile,
  ServerPath,
  Sha256,
} from '../../src/contracts/index.ts';
import { plan, publicWrite } from '../../src/plan/index.ts';

const hashA = 'a'.repeat(64) as Sha256;
const hashB = 'b'.repeat(64) as Sha256;

type Files = Readonly<Record<string, Sha256>>;
type Found = 'same' | 'different' | 'absent';

const dist: Mapping = {
  kind: 'folder',
  local: '/project/dist',
  remote: '',
  localFromConfig: 'dist',
  place: { file: '/project/sealup.yml', line: 1, keyPath: 'upload' },
};

function input(
  localFiles: Files,
  recorded: Files | undefined,
  writes: Readonly<Record<string, Found>>,
): PlanInput {
  const local = new Map<RemotePath, LocalFile>(
    Object.entries(localFiles).map(([path, sha256]) => [
      path as RemotePath,
      { abs: `/project/dist/${path}`, size: 1, sha256 },
    ]),
  );
  const files = new Map<RemotePath, FileRecord>(
    Object.entries(recorded ?? {}).map(([path, sha256]) => [
      path as RemotePath,
      { size: 1, sha256 },
    ]),
  );
  return {
    local,
    remote:
      recorded === undefined
        ? { kind: 'absent' }
        : {
            kind: 'found',
            manifest: { format: 2, folder: '/home/site' as ServerPath, files, pending: [] },
          },
    uploads: [dist],
    exclude: [],
    emptySources: [],
    allow: new Set(),
    writes: Object.entries(writes).map(([path, found]) => ({
      path: path as RemotePath,
      from: 'APP_ENV',
      found,
    })),
  };
}

describe('plan: files written from a secret', () => {
  it('writes a file the server does not have, after its folder and the uploads', () => {
    const result = plan(input({ 'index.html': hashA }, undefined, { 'api/.env': 'absent' }));
    expect(result.ops).toEqual([
      { op: 'mkdir', path: 'api' },
      { op: 'upload', path: 'index.html', reason: 'new', size: 1, sha256: hashA },
      { op: 'write', path: 'api/.env', reason: 'new', from: 'APP_ENV' },
    ]);
    // A secret's size is never counted: the plan line and the progress never hint at it.
    expect(result.bytes).toBe(1);
  });

  it('rewrites a file the server holds with other content, before any delete', () => {
    const result = plan(
      input(
        { 'index.html': hashA },
        { 'index.html': hashA, 'old.js': hashA },
        {
          '.env': 'different',
        },
      ),
    );
    expect(result.ops).toEqual([
      { op: 'write', path: '.env', reason: 'changed', from: 'APP_ENV' },
      { op: 'delete', path: 'old.js', reason: 'left-build' },
    ]);
  });

  it('counts a file the server holds as it is as unchanged, and plans nothing for it', () => {
    const result = plan(
      input({ 'index.html': hashA }, { 'index.html': hashA }, { '.env': 'same' }),
    );
    expect(result.ops).toEqual([]);
    expect(result.unchanged).toBe(2);
  });

  it('never deletes a write path an old manifest recorded as an upload', () => {
    const recorded = { 'index.html': hashA, 'api/.env': hashB };
    for (const found of ['same', 'different', 'absent'] as const) {
      const result = plan(input({ 'index.html': hashA }, recorded, { 'api/.env': found }));
      expect(result.ops.filter((op) => op.op === 'delete' || op.op === 'rmdir')).toEqual([]);
      expect(result.kept).toEqual([]);
    }
  });

  it('never removes the folder of a write path, even when its uploaded files are deleted', () => {
    const result = plan(
      input(
        { 'index.html': hashA },
        { 'index.html': hashA, 'api/old.php': hashA },
        {
          'api/.env': 'same',
        },
      ),
    );
    expect(result.ops).toEqual([{ op: 'delete', path: 'api/old.php', reason: 'left-build' }]);
  });

  it('makes way when a recorded file stands where the write needs a folder (S1)', () => {
    const result = plan(input({}, { api: hashA }, { 'api/.env': 'absent' }));
    expect(result.ops).toEqual([
      { op: 'delete', path: 'api', reason: 'left-build' },
      { op: 'mkdir', path: 'api' },
      { op: 'write', path: 'api/.env', reason: 'new', from: 'APP_ENV' },
    ]);
  });
});

describe('publicWrite: a secret file into a folder that looks public (R17)', () => {
  const secretFile = (path: string, allowPublic = false): SecretFile => ({
    path: path as RemotePath,
    secret: { envName: 'APP_ENV', toString: () => '[secret]', toJSON: () => '[secret]' },
    mode: 0o600,
    allowPublic,
    place: { file: '/project/sealup.yml', line: 7, keyPath: `write.${path}` },
  });

  it.each([
    ['/home/site', 'www/.env', 'www', '/home/site/www/.env'],
    ['/~/public_html', '.env', 'public_html', '/~/public_html/.env'],
    ['/var/www/app', 'config.php', 'www', '/var/www/app/config.php'],
    ['/home/site', 'a/htdocs/b/.env', 'htdocs', '/home/site/a/htdocs/b/.env'],
    ['/srv', 'Public/.env', 'Public', '/srv/Public/.env'],
    ['/inetpub/wwwroot', '.env', 'wwwroot', '/inetpub/wwwroot/.env'],
    ['/home/site/httpdocs', '.env', 'httpdocs', '/home/site/httpdocs/.env'],
    ['/home/site/html', '.env', 'html', '/home/site/html/.env'],
    ['/home/site/web', '.env', 'web', '/home/site/web/.env'],
    ['/home/site/public', '.env', 'public', '/home/site/public/.env'],
  ])('refuses %s + %s: %s looks public', (folder, path, named, full) => {
    const file = secretFile(path);
    expect(publicWrite(folder, [file])).toEqual({ file, folder: named, path: full });
  });

  it.each([
    ['/home/site', 'api/.env'],
    ['/home/www-data/site', '.env'],
    ['/home/site', 'public.env'],
    ['/~/private', 'www.env'],
  ])('lets %s + %s through', (folder, path) => {
    expect(publicWrite(folder, [secretFile(path)])).toBeUndefined();
  });

  it('lets a file with allowPublic through, and names the first other one', () => {
    const allowed = secretFile('www/config.php', true);
    const refused = secretFile('web/.env');
    expect(publicWrite('/home/site', [allowed, refused])?.file).toBe(refused);
    expect(publicWrite('/home/site', [allowed])).toBeUndefined();
  });
});

describe('property: random trees with files written from a secret', () => {
  const names = ['a', 'b.js', '.env', 'config.php'];
  const folders = ['', 'x/', 'x/y/', 'api/'];
  const founds: readonly Found[] = ['same', 'different', 'absent'];
  const random = mulberry32(0x5ec7e7);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) throw new Error('empty pick');
    return item;
  };
  const randomFiles = (): Record<string, Sha256> => {
    const files: Record<string, Sha256> = {};
    const count = Math.floor(random() * 8);
    for (let i = 0; i < count; i++) files[`${pick(folders)}${pick(names)}`] = pick([hashA, hashB]);
    return files;
  };
  /** Write paths under `secret/` (no upload sends there: config stops a clash before plan). */
  const cases = Array.from({ length: 400 }, () => {
    const writes: Record<string, Found> = {};
    const count = Math.floor(random() * 3);
    for (let i = 0; i < count; i++) writes[`secret/${pick(folders)}${pick(names)}`] = pick(founds);
    const recorded = randomFiles();
    // Some write paths were uploads once: an old manifest records them.
    for (const path of Object.keys(writes)) if (random() < 0.5) recorded[path] = hashA;
    return { local: randomFiles(), recorded, writes };
  });

  it('never deletes a write path, nor a folder that holds one', () => {
    for (const c of cases) {
      const result = plan(input(c.local, c.recorded, c.writes));
      const paths = Object.keys(c.writes);
      for (const op of result.ops) {
        if (op.op === 'delete') expect(paths).not.toContain(op.path);
        if (op.op === 'rmdir') {
          expect(paths.some((path) => path.startsWith(`${op.path}/`))).toBe(false);
        }
      }
    }
  });

  it('plans nothing for a tree just deployed, its writes read back the same', () => {
    for (const c of cases) {
      const same = Object.fromEntries(Object.keys(c.writes).map((path) => [path, 'same' as const]));
      const result = plan(input(c.local, c.local, same));
      expect(result.ops).toEqual([]);
      expect(result.unchanged).toBe(Object.keys(c.local).length + Object.keys(same).length);
    }
  });

  it('writes exactly what the server lacks or holds otherwise', () => {
    for (const c of cases) {
      const result = plan(input(c.local, c.recorded, c.writes));
      const written = result.ops.filter((op) => op.op === 'write').map((op) => op.path);
      const expected = Object.entries(c.writes)
        .filter(([, found]) => found !== 'same')
        .map(([path]) => path);
      expect([...written].sort()).toEqual([...expected].sort());
    }
  });

  it('keeps the order: mkdirs, uploads, writes, deletes, rmdirs', () => {
    const rank = { mkdir: 0, upload: 1, write: 2, delete: 3, rmdir: 4 } as const;
    for (const c of cases) {
      const result = plan(input(c.local, c.recorded, c.writes));
      // The removals that make way (S1) come first; the rest keeps the order.
      const making = result.ops.findIndex((op) => op.op !== 'delete' && op.op !== 'rmdir');
      const ranks = result.ops.slice(Math.max(making, 0)).map((op) => rank[op.op]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
});

/** A small seeded PRNG (mulberry32), returns numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
