// scan: the local side of a deploy, on real temp folders (a path with a space included).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mapping, RemotePath } from '../../src/contracts/index.ts';
import { scanLocal } from '../../src/scan/index.ts';

// SHA-256 test vectors (FIPS 180-2 appendix B.1, and the empty input).
const sha = {
  abc: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  empty: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sealup scan '));
  folders.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** `upload: { <folder>: <remote> }` in a sealup.yml at the project root. */
function mapping(
  root: string,
  folder: string,
  remote: Mapping['remote'],
  kind: Mapping['kind'] = 'folder',
): Mapping {
  const place = { file: join(root, 'sealup.yml'), keyPath: `upload.${folder}` };
  return { kind, local: join(root, folder), remote, localFromConfig: folder, place };
}

describe('scanLocal', () => {
  it('hashes every file, keyed by where it goes under the target folder', async () => {
    const root = project({
      'dist/index.html': 'abc',
      'dist/my pages/about us.html': '',
      'dist/a/b/c/deep.txt': 'abc',
    });
    const { files, emptySources } = await scanLocal([mapping(root, 'dist', '')], []);
    expect(emptySources).toEqual([]);
    expect([...files.keys()].sort()).toEqual([
      'a/b/c/deep.txt',
      'index.html',
      'my pages/about us.html',
    ]);
    expect(files.get('my pages/about us.html' as RemotePath)).toEqual({
      abs: join(root, 'dist', 'my pages', 'about us.html'),
      size: 0,
      sha256: sha.empty,
    });
    expect(files.get('index.html' as RemotePath)).toMatchObject({ size: 3, sha256: sha.abc });
  });

  it('puts a mapping under its server folder, keeping names special in JavaScript (R11)', async () => {
    const root = project({ 'public_html/__proto__': 'abc', 'api/constructor': '' });
    const { files } = await scanLocal(
      [
        mapping(root, 'public_html', 'www' as RemotePath),
        mapping(root, 'api', 'api' as RemotePath),
      ],
      [],
    );
    expect([...files.keys()].sort()).toEqual(['api/constructor', 'www/__proto__']);
  });

  it('hashes many files with a bounded number open at once', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 300; i++) many[`dist/f${i}.txt`] = 'abc';
    const root = project(many);
    const { files } = await scanLocal([mapping(root, 'dist', '')], []);
    expect(files.size).toBe(300);
    expect([...files.values()].every((file) => file.sha256 === sha.abc)).toBe(true);
  });

  it('reports a missing or empty source folder instead of throwing', async () => {
    const root = project({ 'dist/x.txt': 'abc' });
    mkdirSync(join(root, 'empty'));
    const empty = mapping(root, 'empty', 'e' as RemotePath);
    const missing = mapping(root, 'missing', 'm' as RemotePath);
    const { files, emptySources } = await scanLocal(
      [mapping(root, 'dist', ''), empty, missing],
      [],
    );
    expect(files.size).toBe(1);
    expect(emptySources).toEqual([
      { mapping: empty, missing: false },
      { mapping: missing, missing: true },
    ]);
  });

  it('never sends an excluded file: .gitignore patterns from the config folder', async () => {
    const root = project({
      'public_html/index.html': 'abc',
      'public_html/resources/cat.jpg': 'abc',
      'public_html/main.js.map': 'abc',
      'api/.env.prod': 'abc',
      'api/app.php': 'abc',
    });
    const { files } = await scanLocal(
      [
        mapping(root, 'public_html', 'www' as RemotePath),
        mapping(root, 'api', 'api' as RemotePath),
      ],
      ['public_html/resources', 'api/.env*', '*.map'],
    );
    expect([...files.keys()]).toEqual(['api/app.php', 'www/index.html']);
  });

  it('reports symlinks without following them, excluded ones left out', async () => {
    const root = project({ 'dist/index.html': 'abc', 'outside/secret.txt': 'abc' });
    symlinkSync(join(root, 'outside'), join(root, 'dist', 'linked'), 'junction');
    symlinkSync(join(root, 'outside'), join(root, 'dist', 'ignored'), 'junction');
    symlinkSync(join(root, 'outside', 'secret.txt'), join(root, 'dist', 'a link.txt'), 'file');
    const { files, symlinks } = await scanLocal([mapping(root, 'dist', '')], ['dist/ignored']);
    expect(symlinks).toEqual(['dist/a link.txt', 'dist/linked']);
    expect([...files.keys()]).toEqual(['index.html']);
  });

  it('sends a single file to its own server path, under another name', async () => {
    const root = project({ 'config/connect.prod.php': 'abc', 'public_html/index.html': '' });
    const file = mapping(root, 'config/connect.prod.php', 'www/connect.php' as RemotePath, 'file');
    const { files, emptySources, symlinks } = await scanLocal(
      [mapping(root, 'public_html', 'www' as RemotePath), file],
      [],
    );
    expect([...files.keys()]).toEqual(['www/connect.php', 'www/index.html']);
    expect(files.get('www/connect.php' as RemotePath)).toEqual({
      abs: join(root, 'config', 'connect.prod.php'),
      size: 3,
      sha256: sha.abc,
    });
    expect(emptySources).toEqual([]);
    expect(symlinks).toEqual([]);
  });

  it('reports a single file that is gone as a missing source, and a linked one as a link', async () => {
    const root = project({ 'outside/secret.txt': 'abc' });
    symlinkSync(join(root, 'outside', 'secret.txt'), join(root, 'linked.txt'), 'file');
    const gone = mapping(root, 'gone.txt', 'gone.txt' as RemotePath, 'file');
    const linked = mapping(root, 'linked.txt', 'linked.txt' as RemotePath, 'file');
    const { files, emptySources, symlinks } = await scanLocal([gone, linked], []);
    expect(files.size).toBe(0);
    expect(emptySources).toEqual([{ mapping: gone, missing: true }]);
    expect(symlinks).toEqual(['linked.txt']);
  });

  it('lists every path each mapping sends, in mapping order, even one sent twice', async () => {
    const root = project({ 'public_html/connect.php': '', 'connect.prod.php': 'abc' });
    const folder = mapping(root, 'public_html', 'www' as RemotePath);
    const file = mapping(root, 'connect.prod.php', 'www/connect.php' as RemotePath, 'file');
    const { sent } = await scanLocal([folder, file], []);
    expect(sent).toEqual([
      { path: 'www/connect.php', mapping: folder },
      { path: 'www/connect.php', mapping: file },
    ]);
  });

  it('reports a source folder whose every file is excluded as empty', async () => {
    const root = project({ 'dist/a.map': 'abc' });
    const dist = mapping(root, 'dist', '');
    const { files, emptySources } = await scanLocal([dist], ['*.map']);
    expect(files.size).toBe(0);
    expect(emptySources).toEqual([{ mapping: dist, missing: false }]);
  });
});
