// plan(), pure (spec #1, seam 3): table tests, then property tests on random trees (R13).

import { describe, expect, it } from 'vitest';
import type {
  AllowedRisk,
  ConfigPlace,
  EmptySource,
  FileRecord,
  LocalFile,
  Manifest,
  Mapping,
  PlanInput,
  RemotePath,
  ServerPath,
  Sha256,
} from '../../src/contracts/index.ts';
import { excludeMatcher, parseRemotePath } from '../../src/paths/index.ts';
import { plan, sameServerPath } from '../../src/plan/index.ts';

const hashA = 'a'.repeat(64) as Sha256;
const hashB = 'b'.repeat(64) as Sha256;

type Files = Readonly<Record<string, readonly [size: number, sha256: Sha256]>>;

/** The place of `upload.<local>` in /project/sealup.yml, at `line` when given. */
function uploadPlace(local: string, line?: number): ConfigPlace {
  return {
    file: '/project/sealup.yml',
    ...(line === undefined ? {} : { line }),
    keyPath: `upload.${local}`,
  };
}

/** `upload: { <local>: <remote> }`, a folder next to sealup.yml. */
function folderMapping(local: string, remote: string): Mapping {
  const to = remote === '' ? '' : (remote as RemotePath);
  return {
    kind: 'folder',
    local: `/project/${local}`,
    remote: to,
    localFromConfig: local,
    place: uploadPlace(local),
  };
}

/** `upload: { <local>: <remote> }`, a single file next to sealup.yml. */
function fileMapping(local: string, remote: string): Mapping {
  return {
    kind: 'file',
    local: `/project/${local}`,
    remote: remote as RemotePath,
    localFromConfig: local,
    place: uploadPlace(local),
  };
}

/** `upload: dist`: the dist/ folder next to sealup.yml goes to the target folder itself. */
const dist: Mapping = folderMapping('dist', '');

function local(files: Files): Map<RemotePath, LocalFile> {
  return new Map(
    Object.entries(files).map(([path, [size, sha256]]) => [
      path as RemotePath,
      { abs: `/project/dist/${path}`, size, sha256 },
    ]),
  );
}

function manifest(files: Files): {
  kind: 'found';
  manifest: Manifest;
} {
  const records = new Map<RemotePath, FileRecord>(
    Object.entries(files).map(([path, [size, sha256]]) => [path as RemotePath, { size, sha256 }]),
  );
  return {
    kind: 'found',
    manifest: { format: 2, folder: '/home/site' as ServerPath, files: records, pending: [] },
  };
}

/** A plan input with `upload: dist`, no exclude, no empty source and no `allow` unless given. */
function input(
  localFiles: Files,
  remote: PlanInput['remote'],
  options: {
    exclude?: readonly string[];
    uploads?: readonly Mapping[];
    emptySources?: readonly EmptySource[];
    allow?: readonly AllowedRisk[];
  } = {},
): PlanInput {
  return {
    local: local(localFiles),
    remote,
    uploads: options.uploads ?? [dist],
    exclude: options.exclude ?? [],
    emptySources: options.emptySources ?? [],
    allow: new Set(options.allow ?? []),
  };
}

describe('plan: first deploy (no manifest)', () => {
  it('uploads every file after creating its folders, parents first', () => {
    const result = plan(
      input(
        {
          'index.html': [10, hashA],
          'assets/js/app.js': [200, hashB],
          'assets/css/site.css': [30, hashA],
          'my pages/about us.html': [5, hashB],
        },
        { kind: 'absent' },
      ),
    );
    expect(result).toEqual({
      ops: [
        { op: 'mkdir', path: 'assets' },
        { op: 'mkdir', path: 'my pages' },
        { op: 'mkdir', path: 'assets/css' },
        { op: 'mkdir', path: 'assets/js' },
        { op: 'upload', path: 'assets/css/site.css', reason: 'new', size: 30, sha256: hashA },
        { op: 'upload', path: 'assets/js/app.js', reason: 'new', size: 200, sha256: hashB },
        { op: 'upload', path: 'index.html', reason: 'new', size: 10, sha256: hashA },
        { op: 'upload', path: 'my pages/about us.html', reason: 'new', size: 5, sha256: hashB },
      ],
      unchanged: 0,
      unchangedBytes: 0,
      bytes: 245,
      kept: [],
      skipped: [],
      firstDeploy: true,
    });
  });

  it('plans nothing for an empty tree', () => {
    expect(plan(input({}, { kind: 'absent' }))).toEqual({
      ops: [],
      unchanged: 0,
      unchangedBytes: 0,
      bytes: 0,
      kept: [],
      skipped: [],
      firstDeploy: true,
    });
  });
});

describe('plan: against a manifest', () => {
  it('uploads new and changed files only, and counts the unchanged ones and their size', () => {
    const result = plan(
      input(
        { 'index.html': [10, hashA], 'app.js': [20, hashB], 'new/page.html': [7, hashA] },
        manifest({ 'index.html': [10, hashA], 'app.js': [20, hashA] }),
      ),
    );
    expect(result).toEqual({
      ops: [
        { op: 'mkdir', path: 'new' },
        { op: 'upload', path: 'app.js', reason: 'changed', size: 20, sha256: hashB },
        { op: 'upload', path: 'new/page.html', reason: 'new', size: 7, sha256: hashA },
      ],
      unchanged: 1,
      unchangedBytes: 10,
      bytes: 27,
      kept: [],
      skipped: [],
      firstDeploy: false,
    });
  });

  it('creates no folder the manifest shows already holds files', () => {
    const result = plan(
      input(
        { 'a/b/new.txt': [1, hashA], 'a/old.txt': [1, hashA] },
        manifest({ 'a/old.txt': [1, hashA] }),
      ),
    );
    expect(result.ops.filter((op) => op.op === 'mkdir')).toEqual([{ op: 'mkdir', path: 'a/b' }]);
  });

  it('plans nothing when the tree was just deployed', () => {
    const files: Files = { 'index.html': [10, hashA], 'a/b.js': [3, hashB] };
    expect(plan(input(files, manifest(files)))).toEqual({
      ops: [],
      unchanged: 2,
      unchangedBytes: 13,
      bytes: 0,
      kept: [],
      skipped: [],
      firstDeploy: false,
    });
  });
});

describe('plan: deletes of files sealup uploaded (decision 0008, R13)', () => {
  it('deletes the recorded files that left the build, after the uploads', () => {
    const result = plan(
      input(
        { 'index.html': [10, hashB], 'main.4f2a.js': [40, hashA] },
        manifest({
          'index.html': [10, hashA],
          'main.8b1e.js': [40, hashB],
          'robots.txt': [1, hashA],
        }),
      ),
    );
    expect(result.ops).toEqual([
      { op: 'upload', path: 'index.html', reason: 'changed', size: 10, sha256: hashB },
      { op: 'upload', path: 'main.4f2a.js', reason: 'new', size: 40, sha256: hashA },
      { op: 'delete', path: 'main.8b1e.js', reason: 'left-build' },
      { op: 'delete', path: 'robots.txt', reason: 'left-build' },
    ]);
    expect(result.bytes).toBe(50);
  });

  it('deletes nothing on a first deploy', () => {
    const result = plan(input({ 'index.html': [10, hashA] }, { kind: 'absent' }));
    expect(result.ops.map((op) => op.op)).toEqual(['upload']);
  });

  it('keeps an excluded file even when the manifest records it, and says why', () => {
    const result = plan(
      input(
        { 'index.html': [10, hashA] },
        manifest({ 'index.html': [10, hashA], 'robots.txt': [1, hashA], 'old.js': [1, hashA] }),
        { exclude: ['dist/robots.txt'] },
      ),
    );
    expect(result.ops).toEqual([{ op: 'delete', path: 'old.js', reason: 'left-build' }]);
    expect(result.kept).toEqual([{ path: 'robots.txt', reason: 'excluded' }]);
  });

  it('maps a manifest path back through its mapping to check the excludes', () => {
    const uploads: Mapping[] = [folderMapping('public_html', 'www'), folderMapping('api', 'api')];
    const result = plan(
      input(
        {},
        manifest({
          'www/resources/cat.jpg': [1, hashA],
          'www/old.js': [1, hashA],
          'api/.env.prod': [1, hashA],
          'api/storage/logs/x.log': [1, hashA],
          'api/old.php': [1, hashA],
          'resources/elsewhere.jpg': [1, hashA],
        }),
        { uploads, exclude: ['public_html/resources', 'api/storage', 'api/.env*'] },
      ),
    );
    expect(result.ops.filter((op) => op.op === 'delete')).toEqual([
      { op: 'delete', path: 'api/old.php', reason: 'left-build' },
      { op: 'delete', path: 'resources/elsewhere.jpg', reason: 'left-build' },
      { op: 'delete', path: 'www/old.js', reason: 'left-build' },
    ]);
    expect(result.kept).toEqual([
      { path: 'api/.env.prod', reason: 'excluded' },
      { path: 'api/storage/logs/x.log', reason: 'excluded' },
      { path: 'www/resources/cat.jpg', reason: 'excluded' },
    ]);
  });

  it('removes the folders that held deleted files and left the build, deepest first', () => {
    const result = plan(
      input(
        { 'index.html': [1, hashA], 'assets/app.js': [1, hashA] },
        manifest({
          'index.html': [1, hashA],
          'assets/app.js': [1, hashA],
          'assets/old/x.js': [1, hashA],
          'admin/js/main.js': [1, hashA],
          'admin/css/site.css': [1, hashA],
          'admin/index.html': [1, hashA],
          'docs/a/b/c.txt': [1, hashA],
        }),
      ),
    );
    expect(result.ops).toEqual([
      { op: 'delete', path: 'admin/css/site.css', reason: 'left-build' },
      { op: 'delete', path: 'admin/index.html', reason: 'left-build' },
      { op: 'delete', path: 'admin/js/main.js', reason: 'left-build' },
      { op: 'delete', path: 'assets/old/x.js', reason: 'left-build' },
      { op: 'delete', path: 'docs/a/b/c.txt', reason: 'left-build' },
      { op: 'rmdir', path: 'docs/a/b' },
      { op: 'rmdir', path: 'admin/css' },
      { op: 'rmdir', path: 'admin/js' },
      { op: 'rmdir', path: 'assets/old' },
      { op: 'rmdir', path: 'docs/a' },
      { op: 'rmdir', path: 'admin' },
      { op: 'rmdir', path: 'docs' },
    ]);
  });

  it('leaves a folder that still holds a kept file', () => {
    const result = plan(
      input(
        { 'index.html': [1, hashA] },
        manifest({ 'index.html': [1, hashA], 'img/a.png': [1, hashA], 'img/keep.png': [1, hashA] }),
        { exclude: ['keep.png'] },
      ),
    );
    expect(result.ops).toEqual([{ op: 'delete', path: 'img/a.png', reason: 'left-build' }]);
  });
});

describe('plan: a file becomes a folder, or a folder a file (S1)', () => {
  it('removes a recorded file right before the folder that takes its name is made', () => {
    const result = plan(
      input(
        { 'index.html': [1, hashA], 'docs/a.html': [2, hashB] },
        manifest({ 'index.html': [1, hashA], docs: [3, hashA], 'old.js': [1, hashA] }),
      ),
    );
    expect(result.blocked).toBeUndefined();
    expect(result.ops).toEqual([
      { op: 'delete', path: 'docs', reason: 'left-build' },
      { op: 'mkdir', path: 'docs' },
      { op: 'upload', path: 'docs/a.html', reason: 'new', size: 2, sha256: hashB },
      { op: 'delete', path: 'old.js', reason: 'left-build' },
    ]);
  });

  it('empties and removes a recorded folder before the file that takes its name is sent', () => {
    const result = plan(
      input(
        { 'index.html': [1, hashA], docs: [3, hashB] },
        manifest({
          'index.html': [1, hashA],
          'docs/a.html': [1, hashA],
          'docs/img/b.png': [1, hashA],
          'old.js': [1, hashA],
        }),
      ),
    );
    expect(result.blocked).toBeUndefined();
    expect(result.ops).toEqual([
      { op: 'delete', path: 'docs/a.html', reason: 'left-build' },
      { op: 'delete', path: 'docs/img/b.png', reason: 'left-build' },
      { op: 'rmdir', path: 'docs/img' },
      { op: 'rmdir', path: 'docs' },
      { op: 'upload', path: 'docs', reason: 'new', size: 3, sha256: hashB },
      { op: 'delete', path: 'old.js', reason: 'left-build' },
    ]);
  });

  it('is blocked when a kept (excluded) file is in the folder a file must replace', () => {
    const result = plan(
      input(
        { docs: [3, hashB] },
        manifest({ 'docs/a.html': [1, hashA], 'docs/keep.txt': [1, hashA] }),
        { exclude: ['dist/docs/keep.txt'] },
      ),
    );
    expect(result.blocked).toEqual({ reason: 'in-the-way', path: 'docs', found: 'folder' });
  });

  it('is blocked when a kept (excluded) file holds the name a folder needs', () => {
    // A scan never sends a file inside an excluded path; plan does not rely on that.
    const result = plan(
      input({ 'docs/a.html': [1, hashA] }, manifest({ docs: [1, hashA] }), {
        exclude: ['dist/docs'],
      }),
    );
    expect(result.blocked).toEqual({ reason: 'in-the-way', path: 'docs', found: 'file' });
  });
});

describe('property: a build that swaps files and folders (S1)', () => {
  // Trees from names that can be a file in one build and a folder in the other.
  const random = mulberry32(0x5a1f0e);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) throw new Error('empty pick');
    return item;
  };
  const segments = ['a', 'b', 'c'];
  /** A random consistent tree: no path is both a file and a folder. */
  const randomTree = (): Files => {
    const files: Record<string, readonly [number, Sha256]> = {};
    const count = Math.floor(random() * 6);
    for (let i = 0; i < count; i++) {
      const depth = 1 + Math.floor(random() * 3);
      const path = Array.from({ length: depth }, () => pick(segments)).join('/');
      const clash = Object.keys(files).some(
        (other) => other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`),
      );
      if (!clash) files[path] = [1, pick([hashA, hashB])];
    }
    return files;
  };
  const cases = Array.from({ length: 1000 }, () => ({
    local: randomTree(),
    recorded: randomTree(),
    exclude: random() < 0.2 ? [`dist/${pick(segments)}/${pick(segments)}`] : [],
  }));

  type Server = Map<string, 'file' | 'folder'>;
  /** The server after a deploy of `files`: each file and the folders above it. */
  const serverOf = (files: Files): Server => {
    const server: Server = new Map();
    for (const path of Object.keys(files)) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) server.set(parts.slice(0, i).join('/'), 'folder');
      server.set(path, 'file');
    }
    return server;
  };
  const parentOk = (server: Server, path: string): boolean => {
    const slash = path.lastIndexOf('/');
    return slash === -1 || server.get(path.slice(0, slash)) === 'folder';
  };
  /** Applies the ops in order, as a server would; throws on an op the server would refuse. */
  const apply = (server: Server, ops: ReturnType<typeof plan>['ops']): void => {
    for (const op of ops) {
      const there = server.get(op.path);
      if (op.op === 'mkdir') {
        if (there === 'file') throw new Error(`mkdir ${op.path}: a file is in the way`);
        if (!parentOk(server, op.path)) throw new Error(`mkdir ${op.path}: no parent`);
        server.set(op.path, 'folder');
      } else if (op.op === 'upload') {
        if (there === 'folder') throw new Error(`upload ${op.path}: a folder is in the way`);
        if (!parentOk(server, op.path)) throw new Error(`upload ${op.path}: no parent`);
        server.set(op.path, 'file');
      } else if (op.op === 'delete') {
        if (there === 'folder') throw new Error(`delete ${op.path}: a folder`);
        server.delete(op.path);
      } else {
        const full = [...server.keys()].some((path) => path.startsWith(`${op.path}/`));
        if (there === 'folder' && !full) server.delete(op.path);
      }
    }
  };

  it('applied in order, never meets a path held by the other kind, and ends with the build', () => {
    let swaps = 0;
    for (const c of cases) {
      const result = plan(input(c.local, manifest(c.recorded), { exclude: c.exclude }));
      if (result.blocked !== undefined) continue;
      const server = serverOf(c.recorded);
      apply(server, result.ops);
      const before = serverOf(c.recorded);
      if (
        [...serverOf(c.local)].some(([path, kind]) => before.has(path) && before.get(path) !== kind)
      ) {
        swaps++;
      }
      const excluded = excludeMatcher(c.exclude);
      const keptHere = Object.keys(c.recorded).filter(
        (path) => !(path in c.local) && excluded(`dist/${path}`),
      );
      const files = [...server].filter(([, kind]) => kind === 'file').map(([path]) => path);
      expect(files.sort()).toEqual([...Object.keys(c.local), ...keptHere].sort());
    }
    // The cases hold real swaps, not only plain trees.
    expect(swaps).toBeGreaterThan(100);
  });

  it('is blocked only by a kept file in the way, and then names that path', () => {
    for (const c of cases) {
      const result = plan(input(c.local, manifest(c.recorded), { exclude: c.exclude }));
      if (result.blocked?.reason !== 'in-the-way') continue;
      const { path, found } = result.blocked;
      const excluded = excludeMatcher(c.exclude);
      const kept = Object.keys(c.recorded).filter(
        (recorded) => !(recorded in c.local) && excluded(`dist/${recorded}`),
      );
      if (found === 'file') expect(kept).toContain(path);
      else expect(kept.some((recorded) => recorded.startsWith(`${path}/`))).toBe(true);
    }
  });

  it('a rerun after any prefix of the ops plans the rest and ends with the build', () => {
    for (const c of cases.slice(0, 300)) {
      const first = plan(input(c.local, manifest(c.recorded), { exclude: c.exclude }));
      if (first.blocked !== undefined) continue;
      for (let stop = 0; stop <= first.ops.length; stop++) {
        // The manifest a stopped run writes: the old records, plus what arrived, minus what
        // was deleted. The removals that make way (before the first mkdir or upload) drop their
        // records only once all of them ran, so a rerun repeats them until the way is clear.
        const done = first.ops.slice(0, stop);
        const making = first.ops.findIndex((op) => op.op === 'mkdir' || op.op === 'upload');
        const way = making === -1 ? 0 : making;
        const records: Record<string, readonly [number, Sha256]> = { ...c.recorded };
        done.forEach((op, i) => {
          if (op.op === 'delete' && (i >= way || stop >= way)) delete records[op.path];
          if (op.op === 'upload') records[op.path] = [op.size, op.sha256];
        });
        const server = serverOf(c.recorded);
        apply(server, done);
        const rerun = plan(input(c.local, manifest(records), { exclude: c.exclude }));
        expect(rerun.blocked).toBeUndefined();
        apply(server, rerun.ops);
        const excluded = excludeMatcher(c.exclude);
        const kept = Object.keys(records).filter(
          (path) => !(path in c.local) && excluded(`dist/${path}`),
        );
        const files = [...server].filter(([, kind]) => kind === 'file').map(([path]) => path);
        expect(files.sort()).toEqual([...Object.keys(c.local), ...kept].sort());
      }
    }
  });
});

describe('plan: single files in upload (scope v1, spec #24 decision 23)', () => {
  const connect = fileMapping('config/connect.prod.php', 'www/connect.php');
  const www = folderMapping('public_html', 'www');

  it('uploads a single file under its own server name, its folders first', () => {
    const result = plan(
      input({ 'www/connect.php': [5, hashA] }, { kind: 'absent' }, { uploads: [connect] }),
    );
    expect(result.ops).toEqual([
      { op: 'mkdir', path: 'www' },
      { op: 'upload', path: 'www/connect.php', reason: 'new', size: 5, sha256: hashA },
    ]);
  });

  it('skips it when unchanged, uploads it when changed, like any uploaded file', () => {
    const recorded = manifest({ 'www/connect.php': [5, hashA], 'www/index.html': [1, hashA] });
    const uploads = [www, connect];
    const same = plan(
      input({ 'www/connect.php': [5, hashA], 'www/index.html': [1, hashA] }, recorded, { uploads }),
    );
    expect(same.ops).toEqual([]);
    expect(same.unchanged).toBe(2);
    const changed = plan(
      input({ 'www/connect.php': [6, hashB], 'www/index.html': [1, hashA] }, recorded, { uploads }),
    );
    expect(changed.ops).toEqual([
      { op: 'upload', path: 'www/connect.php', reason: 'changed', size: 6, sha256: hashB },
    ]);
  });

  it('deletes it once it leaves the config: it is tool-owned', () => {
    const result = plan(
      input(
        { 'www/index.html': [1, hashA] },
        manifest({ 'www/connect.php': [5, hashA], 'www/index.html': [1, hashA] }),
        { uploads: [www] },
      ),
    );
    expect(result.ops).toEqual([{ op: 'delete', path: 'www/connect.php', reason: 'left-build' }]);
  });

  it('holds only its own path: what was under it as a folder is not its to exclude', () => {
    // `www/connect.php` was a folder sent by an old mapping; now a single file goes there. The
    // pattern `x` (any file named x) must not reach `www/connect.php/x` through the file.
    const result = plan(
      input({ 'www/connect.php': [5, hashA] }, manifest({ 'www/connect.php/x': [1, hashA] }), {
        uploads: [connect],
        exclude: ['x'],
      }),
    );
    expect(result.blocked).toBeUndefined();
    expect(result.ops).toEqual([
      { op: 'delete', path: 'www/connect.php/x', reason: 'left-build' },
      { op: 'rmdir', path: 'www/connect.php' },
      { op: 'upload', path: 'www/connect.php', reason: 'new', size: 5, sha256: hashA },
    ]);
  });
});

describe('sameServerPath: two entries that send one server path (story 43)', () => {
  const owners = new Map<string, object>();
  const entry = (path: string, local: string, line: number) => ({
    path: path as RemotePath,
    entry: owner(local, line),
    place: uploadPlace(local, line),
  });
  function owner(local: string, line: number): object {
    const key = `${local}:${line}`;
    const token = owners.get(key) ?? {};
    owners.set(key, token);
    return token;
  }

  it('finds none when every entry sends its own paths', () => {
    const entries = [
      entry('www/index.html', 'public_html', 3),
      entry('www/a/b.js', 'public_html', 3),
      entry('www/connect.php', 'connect.prod.php', 4),
      entry('www/a/c.js', 'build', 5),
    ];
    expect(sameServerPath(entries)).toBeUndefined();
  });

  it('names the later entry, the earlier one and the path they share', () => {
    const entries = [
      entry('www/index.html', 'public_html', 3),
      entry('www/connect.php', 'public_html', 3),
      entry('www/connect.php', 'connect.prod.php', 4),
    ];
    expect(sameServerPath(entries)).toEqual({
      code: 'same-server-path',
      ...uploadPlace('connect.prod.php', 4),
      other: uploadPlace('public_html', 3),
      path: 'www/connect.php',
    });
  });

  it('finds a file one entry sends where another needs a folder, either way round', () => {
    const fileFirst = [entry('www/a', 'a.txt', 3), entry('www/a/b.js', 'public_html', 4)];
    expect(sameServerPath(fileFirst)).toMatchObject({ line: 4, other: { line: 3 }, path: 'www/a' });
    const folderFirst = [entry('www/a/b.js', 'public_html', 3), entry('www/a', 'a.txt', 4)];
    expect(sameServerPath(folderFirst)).toMatchObject({
      line: 4,
      other: { line: 3 },
      path: 'www/a',
    });
  });

  it('leaves one entry that lists a path twice to the scan (one line, nothing to name)', () => {
    const entries = [entry('www/a', 'public_html', 3), entry('www/a', 'public_html', 3)];
    expect(sameServerPath(entries)).toBeUndefined();
  });
});

describe('property: random trees, manifests and excludes (R13)', () => {
  // Seeded, so a failure reproduces. Names and patterns from small sets, so trees overlap.
  const names = ['a', 'b', 'c.js', 'd.map', '.env', 'robots.txt'];
  const folders = ['', 'x/', 'x/y/', 'z/', 'resources/'];
  const patterns = ['*.map', 'dist/x/y', 'dist/resources', '.env', 'dist/z/', 'b', '!b'];
  const hashes = [hashA, hashB];
  const random = mulberry32(0x5ea106);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) throw new Error('empty pick');
    return item;
  };
  const randomFiles = (): Files => {
    const files: Record<string, readonly [number, Sha256]> = {};
    const count = Math.floor(random() * 10);
    for (let i = 0; i < count; i++) files[`${pick(folders)}${pick(names)}`] = [1, pick(hashes)];
    return files;
  };
  const cases = Array.from({ length: 500 }, () => {
    const exclude = Array.from({ length: Math.floor(random() * 3) }, () => pick(patterns));
    return { local: randomFiles(), recorded: randomFiles(), exclude };
  });

  it('never plans an op outside the target folder', () => {
    for (const c of cases) {
      const result = plan(input(c.local, manifest(c.recorded), { exclude: c.exclude }));
      for (const op of result.ops) expect(parseRemotePath(op.path).ok).toBe(true);
    }
  });

  it('deletes exactly old manifest ∩ not excluded ∩ not in the source; keeps the excluded rest', () => {
    for (const c of cases) {
      const result = plan(input(c.local, manifest(c.recorded), { exclude: c.exclude }));
      const excluded = excludeMatcher(c.exclude);
      const gone = Object.keys(c.recorded).filter((path) => !(path in c.local));
      const deletes = result.ops.filter((op) => op.op === 'delete').map((op) => op.path);
      expect(deletes).toEqual(gone.filter((path) => !excluded(`dist/${path}`)).sort());
      expect(result.kept.map((k) => k.path)).toEqual(
        gone.filter((path) => excluded(`dist/${path}`)).sort(),
      );
    }
  });

  it('removes only folders that hold nothing of the source and nothing kept', () => {
    for (const c of cases) {
      const result = plan(input(c.local, manifest(c.recorded), { exclude: c.exclude }));
      const staying = [...Object.keys(c.local), ...result.kept.map((k) => k.path)];
      const rmdirs = result.ops.filter((op) => op.op === 'rmdir').map((op) => op.path);
      for (const folder of rmdirs) {
        expect(staying.some((path) => path.startsWith(`${folder}/`))).toBe(false);
      }
      const depths = rmdirs.map((path) => path.split('/').length);
      expect(depths).toEqual([...depths].sort((a, b) => b - a));
    }
  });

  it('plans nothing for a tree that was just deployed', () => {
    for (const c of cases) {
      const result = plan(input(c.local, manifest(c.local), { exclude: c.exclude }));
      expect(result.ops).toEqual([]);
      expect(result.unchanged).toBe(Object.keys(c.local).length);
    }
  });

  it('deletes nothing on a first deploy', () => {
    for (const c of cases) {
      const result = plan(input(c.local, { kind: 'absent' }, { exclude: c.exclude }));
      expect(result.ops.filter((op) => op.op === 'delete' || op.op === 'rmdir')).toEqual([]);
      expect(result.kept).toEqual([]);
    }
  });

  it('blocks on an empty source, unless the target allows it; on a missing one always', () => {
    for (const c of cases) {
      const emptySources: EmptySource[] =
        Object.keys(c.local).length === 0 ? [{ mapping: dist, missing: random() < 0.5 }] : [];
      const blocked = plan(
        input(c.local, manifest(c.recorded), { exclude: c.exclude, emptySources }),
      );
      expect(blocked.blocked?.reason === 'empty-source').toBe(emptySources.length > 0);
      const allowed = plan(
        input(c.local, manifest(c.recorded), {
          exclude: c.exclude,
          emptySources,
          allow: ['empty-source'],
        }),
      );
      // A missing local path is never planned as a source that sends nothing (decision 23).
      expect(allowed.blocked?.reason === 'empty-source').toBe(
        emptySources.some(({ missing }) => missing),
      );
    }
  });

  /** Up to two single files (`single/<name>`, a folder dist never fills), beside `dist`. */
  const singles = (): Mapping[] =>
    Array.from({ length: Math.floor(random() * 3) }, (_, i) =>
      fileMapping(`file${i}.prod`, `single/${pick(names)}${i}`),
    );
  const withSingles = (files: Files, mappings: readonly Mapping[]): Files => ({
    ...files,
    ...Object.fromEntries(mappings.map((m) => [m.remote, [1, hashA] as const])),
  });

  it('with single files: plans nothing for a tree that was just deployed', () => {
    for (const c of cases) {
      const files = singles();
      const tree = withSingles(c.local, files);
      const uploads = [dist, ...files];
      const result = plan(input(tree, manifest(tree), { exclude: c.exclude, uploads }));
      expect(result.ops).toEqual([]);
      expect(result.unchanged).toBe(Object.keys(tree).length);
    }
  });

  it('with single files: deletes each one that left the config, never one still in it', () => {
    for (const c of cases) {
      const [kept, ...gone] = singles();
      const before = withSingles(
        c.recorded,
        [kept, ...gone].filter((m) => m !== undefined),
      );
      const still = kept === undefined ? [] : [kept];
      const result = plan(
        input(withSingles(c.local, still), manifest(before), {
          exclude: c.exclude,
          uploads: [dist, ...still],
        }),
      );
      const deletes = result.ops.filter((op) => op.op === 'delete').map((op) => op.path);
      for (const mapping of gone) expect(deletes).toContain(mapping.remote);
      for (const mapping of still) expect(deletes).not.toContain(mapping.remote);
    }
  });

  it('keeps the order: mkdirs, uploads, deletes, rmdirs', () => {
    const rank = { mkdir: 0, upload: 1, write: 2, delete: 3, rmdir: 4 } as const;
    for (const c of cases) {
      const ranks = plan(input(c.local, manifest(c.recorded), { exclude: c.exclude })).ops.map(
        (op) => rank[op.op],
      );
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
