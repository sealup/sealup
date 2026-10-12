// The public tree (decision 0035): the export keeps an allow-list of paths, then scans each kept
// file for denied strings; any hit, or a workflow in neither list, stops the export.
//
// This file is public and the export scans it: each denied string below is cut by `${_}` (an
// empty string), so the source never holds it whole and only the test's values do.

import { describe, expect, it } from 'vitest';
import { parseNames, publicTree, scanFiles, touchesPublicTree } from '../../scripts/public-tree.ts';

const _ = '';
const clean = (): string => 'export const ok = true;\n';

describe('the allow-list', () => {
  it('keeps the public paths and leaves out the private ones', () => {
    const paths = [
      'src/cli/index.ts',
      'test/unit/x.test.ts',
      'scripts/build.ts',
      'site/src/content/docs/index.md',
      '.githooks/pre-commit',
      'action.yml',
      'dist/action.mjs',
      'dist/cli.mjs',
      'schema.json',
      'LICENSE',
      'package.json',
      'package-lock.json',
      '.npmrc',
      'tsconfig.json',
      'biome.json',
      'knip.json',
      'vitest.config.ts',
      '.gitignore',
      '.gitattributes',
      'README.md',
      'GLOSSARY.md',
      'SECURITY.md',
      'AGENTS.md',
      'CLAUDE.md',
      'docs/adr/0001-x.md',
      'spikes/01/bench.mjs',
      'tools/README.md',
      '.claude/settings.json',
      '.github/workflows/ci.yml',
      '.github/workflows/public-sync.yml',
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/dependabot.yml',
      '.github/pull_request_template.md',
      'release-please-config.json',
      'src',
    ];
    const tree = publicTree({ paths, read: clean });
    expect(tree.errors).toEqual([]);
    expect(tree.files).toEqual([
      '.gitattributes',
      '.githooks/pre-commit',
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/dependabot.yml',
      '.github/pull_request_template.md',
      '.github/workflows/ci.yml',
      '.gitignore',
      '.npmrc',
      'GLOSSARY.md',
      'LICENSE',
      'README.md',
      'SECURITY.md',
      'action.yml',
      'biome.json',
      'dist/action.mjs',
      'knip.json',
      'package-lock.json',
      'package.json',
      'schema.json',
      'scripts/build.ts',
      'site/src/content/docs/index.md',
      'src/cli/index.ts',
      'test/unit/x.test.ts',
      'tsconfig.json',
      'vitest.config.ts',
    ]);
  });

  it('leaves out test/private/, the tests of files that stay private', () => {
    const tree = publicTree({
      paths: ['test/private/release.test.ts', 'test/gates/export.test.ts'],
      read: clean,
    });
    expect(tree.files).toEqual(['test/gates/export.test.ts']);
  });

  it('stops on a workflow that is neither public nor private', () => {
    const tree = publicTree({
      paths: ['src/a.ts', '.github/workflows/new-one.yml'],
      read: clean,
    });
    expect(tree.ok).toBe(false);
    expect(tree.errors).toEqual([
      '.github/workflows/new-one.yml: a workflow in neither list; name it public or private in scripts/public-tree.ts',
    ]);
  });
});

// CI's release dry run exports the tree and runs the public repo's checks on it: a change that
// touches no public path leaves it as it was, so the private repo skips it (ruling 10).
describe('what a change touches', () => {
  it.each([
    ['docs only', ['docs/plans/05-notes/decision-log.md', 'docs/adr/0001-x.md']],
    ['the private tests and the agents file', ['test/private/release.test.ts', 'AGENTS.md']],
    [
      'a private workflow and the release config',
      ['.github/workflows/public-sync.yml', 'release-please-config.json'],
    ],
    ['nothing', []],
  ])('leaves the public tree alone: %s', (_label, paths) => {
    expect(touchesPublicTree(paths)).toBe(false);
  });

  it.each([
    ['the source', ['docs/x.md', 'src/cli/index.ts']],
    ['a public test', ['test/gates/export.test.ts']],
    ['a script', ['scripts/public-tree.ts']],
    ['a public workflow', ['.github/workflows/ci.yml']],
    ['a root .md file', ['README.md']],
    ['the lockfile', ['package-lock.json']],
    ['a workflow in neither list, which stops the export', ['.github/workflows/new-one.yml']],
  ])('touches the public tree: %s', (_label, paths) => {
    expect(touchesPublicTree(paths)).toBe(true);
  });
});

/** The public tree of one file with this content. */
const one = (content: string, path = 'src/a.ts', names?: readonly string[]) =>
  publicTree({ paths: [path], read: () => content, names });

describe('the scan', () => {
  it.each([
    ['ovh-cluster-host', `host: ssh.cluster${_}000.hosting.ovh.net`],
    ['ovh-cluster-host', `see FTP.CLUSTER${_}00.hosting`],
    ['bench-folder', `folder: '/~/deploy${_}-bench/site'`],
    ['bench-folder', `deploy${_}_bench`],
    ['local-drive-path', `C:${_}\\Users\\someone\\project`],
    ['local-drive-path', `d:${_}/workspaces/x`],
    ['local-drive-path', `"H:${_}\\\\anything"`],
    ['local-drive-path', `file:///H:${_}/x`],
    ['local-drive-path', `cd /c${_}/Users/someone`],
    ['local-drive-path', `cd /h${_}/workspaces/x`],
  ])('finds %s in %j', (kind, line) => {
    const tree = one(`first line\n  ${line}\n`);
    expect(tree.ok).toBe(false);
    expect(tree.hits).toEqual([{ path: 'src/a.ts', line: 2, column: expect.any(Number), kind }]);
    expect(tree.errors).toEqual([expect.stringMatching(new RegExp(`^src/a\\.ts:2:\\d+ ${kind}$`))]);
  });

  it.each([
    'ssh.clusterXXX.hosting.ovh.net',
    'OVH Perso',
    'tinybench and 01-benchmark',
    'C:\\x',
    "'D:\\\\other'",
    'C:\\Windows\\x.dll',
    '/home/deploy/site',
    'https://example.com/a',
  ])('passes %j', (line) => {
    expect(one(`${line}\n`)).toMatchObject({ ok: true, hits: [], errors: [] });
  });

  it('names the line and column of the hit, and never the string', () => {
    const tree = one(`x\r\nab deploy${_}-bench`);
    expect(tree.hits).toEqual([{ path: 'src/a.ts', line: 2, column: 4, kind: 'bench-folder' }]);
    expect(tree.errors).toEqual(['src/a.ts:2:4 bench-folder']);
  });

  it('scans the path too (line 0)', () => {
    const path = `test/deploy${_}-bench/a.ts`;
    const tree = one('', path);
    expect(tree.hits).toEqual([{ path, line: 0, column: 6, kind: 'bench-folder' }]);
    expect(tree.errors).toEqual([`${path}: the path holds bench-folder`]);
  });

  it('scans only the public files', () => {
    const tree = publicTree({ paths: ['docs/a.md'], read: () => `deploy${_}-bench` });
    expect(tree).toMatchObject({ ok: true, files: [], hits: [] });
  });
});

describe('the names list', () => {
  it('reads one name per line, skipping comments and blank lines', () => {
    const text = "# clients\r\nAcme Bakery\n\n  Globex  \n# the owner's projects\nhelios\n";
    expect(parseNames(text)).toEqual(['Acme Bakery', 'Globex', 'helios']);
  });

  it.each([
    'Acme Bakery',
    'ACME BAKERY',
    'acme-bakery.example.com',
    'acme_bakery',
    'www.acmebakery.example',
    'acme.bakery',
  ])('finds a name in %j', (line) => {
    const tree = one(`${line}\n`, 'src/a.ts', ['Acme Bakery']);
    expect(tree.hits).toEqual([
      { path: 'src/a.ts', line: 1, column: expect.any(Number), kind: 'private-name' },
    ]);
  });

  it.each(['acmebakeryx', 'xacme bakery', 'Acme', 'Bakery', 'acme  bakery'])(
    'passes %j',
    (line) => {
      expect(one(`${line}\n`, 'src/a.ts', ['Acme Bakery']).hits).toEqual([]);
    },
  );

  it('treats a name as text, not as a pattern', () => {
    expect(one('a+b c.d (x\n', 'src/a.ts', ['a+b', 'c.d', '(x']).hits).toHaveLength(3);
    expect(one('aab cxd\n', 'src/a.ts', ['a+b']).hits).toEqual([]);
  });

  it('finds a name in a path', () => {
    expect(one('', 'site/globex/a.md', ['Globex']).errors).toEqual([
      'site/globex/a.md: the path holds private-name',
    ]);
  });

  it('says so when there is no list, and goes on', () => {
    const tree = publicTree({ paths: ['src/a.ts'], read: clean });
    expect(tree.ok).toBe(true);
    expect(tree.notes).toEqual([
      "No names list: client names and the owner's other projects were not checked.",
    ]);
  });

  it('fails in release mode when there is no list', () => {
    const tree = publicTree({ paths: ['src/a.ts'], read: clean, release: true });
    expect(tree.ok).toBe(false);
    expect(tree.errors).toEqual([
      "No names list: a release checks client names and the owner's other projects.",
    ]);
  });

  it('fails in release mode on an empty list', () => {
    const tree = publicTree({ paths: ['src/a.ts'], read: clean, names: [], release: true });
    expect(tree.errors).toEqual(['The names list is empty: a release checks at least one name.']);
  });

  it('passes a clean release that has a list', () => {
    const tree = publicTree({ paths: ['src/a.ts'], read: clean, names: ['Globex'], release: true });
    expect(tree).toMatchObject({ ok: true, files: ['src/a.ts'], errors: [], notes: [] });
  });

  it('has no note when a list is given', () => {
    expect(one('x', 'src/a.ts', ['Globex']).notes).toEqual([]);
  });
});

describe('the proven-to-bite fixtures', () => {
  const fixture = 'test/gates/bad/export/bench-folder.txt';

  it('may hold the built-in kinds', () => {
    const tree = one(`deploy${_}-bench and ssh.cluster${_}000\n`, fixture);
    expect(tree).toMatchObject({ ok: true, files: [fixture], hits: [] });
  });

  it('may not hold a private name', () => {
    expect(one('Globex\n', fixture, ['Globex']).errors).toEqual([`${fixture}:1:1 private-name`]);
  });

  it('are excused in that folder only', () => {
    expect(one(`deploy${_}-bench\n`, 'test/gates/bad/other/a.txt').ok).toBe(false);
  });

  it('are not excused by scanFiles, which takes every file as given', () => {
    const tree = scanFiles({ paths: [fixture, 'docs/a.md'], read: () => `deploy${_}-bench` });
    expect(tree.files).toEqual(['docs/a.md', fixture]);
    expect(tree.errors).toEqual(['docs/a.md:1:1 bench-folder', `${fixture}:1:1 bench-folder`]);
  });
});

// Decision 0042: the public CHANGELOG.md is written at each release; the export stops when its
// newest section is not the version being released, or when it links to another repo.
describe('the public changelog', () => {
  const tree = (changelog: string, pkg = '{"name":"sealup","version":"0.2.0"}\n') =>
    publicTree({
      paths: ['CHANGELOG.md', 'package.json'],
      read: (path) => (path === 'CHANGELOG.md' ? changelog : pkg),
    });
  const compare = 'https://github.com/sealup/sealup/compare';

  it.each([
    ['a linked heading', `# Changelog\n\n## [0.2.0](${compare}/v0.1.1...v0.2.0) (2026-10-20)\n`],
    ['a plain heading', '# Changelog\n\n## 0.2.0 (2026-10-20)\n\n## 0.1.0 (2026-10-10)\n'],
  ])("passes when the newest section is package.json's version (%s)", (_name, changelog) => {
    expect(tree(changelog)).toMatchObject({ ok: true, errors: [] });
  });

  it("stops when release-please moved the version and the section isn't written yet", () => {
    expect(
      tree(`# Changelog\n\n## [0.1.1](${compare}/v0.1.0...v0.1.1) (2026-10-11)\n`).errors,
    ).toEqual([
      "CHANGELOG.md: its newest section is 0.1.1, not package.json's 0.2.0; write 0.2.0's section first",
    ]);
  });

  it('stops when there is no section at all', () => {
    expect(tree('# Changelog\n').errors).toEqual([
      "CHANGELOG.md: its newest section is missing, not package.json's 0.2.0; write 0.2.0's section first",
    ]);
  });

  it.each([
    ['a pull request', '[#4](https://github.com/sealup/sealup/pull/4)'],
    ['the clone URL', '`https://github.com/sealup/sealup.git`'],
    ['the repo at the end of a sentence', 'See https://github.com/sealup/sealup.'],
  ])('passes a link to the public repo (%s)', (_name, link) => {
    expect(tree(`## 0.2.0 (2026-10-20)\n\n* ${link}\n`)).toMatchObject({ ok: true, errors: [] });
  });

  it('stops on a link to another repo, naming its place', () => {
    const changelog = `# Changelog\n\n## 0.2.0 (2026-10-20)\n\n* a fix ([abc](https://github.com/sealup/sealup-private/commit/abc))\n`;
    expect(tree(changelog).errors).toEqual([
      'CHANGELOG.md:5:24 links to a repo other than sealup/sealup',
    ]);
  });

  it('stops when package.json is not JSON', () => {
    expect(tree('## 0.2.0\n', 'not json').errors).toEqual([
      'package.json: not JSON, so CHANGELOG.md cannot be checked against its version',
    ]);
  });

  it('is not checked without both files', () => {
    for (const paths of [['CHANGELOG.md'], ['package.json']]) {
      expect(publicTree({ paths, read: () => '# Changelog\n' }).errors).toEqual([]);
    }
  });
});
