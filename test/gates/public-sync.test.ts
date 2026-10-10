// The public sync (decision 0035; spec #41 decision 35): scripts/public-sync.ts turns an exported
// tree into one commit on the public repo's `main` and the tag `vX.Y.Z`, pushed together. Driven
// here against a local bare repo standing in for the public one: no network, no GitHub.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { gitEnv } from '../../scripts/git-env.ts';
import { type GateRun, runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'public-sync.ts');
const author = 'sealup-release[bot] <1+sealup-release[bot]@users.noreply.github.com>';

/** Git in `cwd`, with no user or system config, so the owner's settings never change a result. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnv({ GIT_CONFIG_GLOBAL: '', GIT_CONFIG_NOSYSTEM: '1' }),
  }).trim();

const temps: string[] = [];
afterAll(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

interface Bed {
  /** The bare repo standing in for the public one. */
  readonly remote: string;
  /** Writes an exported tree: a package.json at `version` and the given files. */
  readonly tree: (name: string, version: string, files: Record<string, string>) => string;
  readonly sync: (folder: string, ...more: string[]) => Promise<GateRun>;
  /** The files of `ref` in the public repo, sorted. */
  readonly filesAt: (ref: string) => string[];
}

/** A temp folder with its own empty public repo, so the tests run at once. */
function bed(): Bed {
  const temp = mkdtempSync(join(tmpdir(), 'sealup-public-sync-'));
  temps.push(temp);
  const remote = join(temp, 'public.git');
  git(temp, 'init', '--bare', '--quiet', remote);
  return {
    remote,
    tree: (name, version, files) => {
      const folder = join(temp, name);
      const all = { 'package.json': `${JSON.stringify({ name: 'sealup', version })}\n`, ...files };
      for (const [path, content] of Object.entries(all)) {
        const file = join(folder, ...path.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      return folder;
    },
    sync: (folder, ...more) =>
      runNode([script, folder, '--remote', remote, '--author', author, ...more], repoRoot),
    filesAt: (ref) => git(remote, 'ls-tree', '-r', '--name-only', ref).split('\n').sort(),
  };
}

describe.concurrent('the public sync', () => {
  it('makes the first public commit and its tag in an empty repo', async () => {
    const { remote, tree, sync, filesAt } = bed();
    const run = await sync(tree('one', '0.1.0', { 'README.md': '# sealup\n' }), '--push');
    expect(run.exitCode, run.output).toBe(0);
    expect(filesAt('main')).toEqual(['README.md', 'package.json']);
    expect(git(remote, 'rev-parse', 'v0.1.0^{commit}')).toBe(git(remote, 'rev-parse', 'main'));
    expect(git(remote, 'log', '--format=%s|%an <%ae>', 'main')).toBe(`sealup v0.1.0|${author}`);
  });

  it('keeps a file the tree ignores, such as the committed action bundle', async () => {
    const { tree, sync, filesAt } = bed();
    const folder = tree('one', '0.1.0', { '.gitignore': 'dist/*\n', 'dist/action.mjs': 'x\n' });
    const run = await sync(folder, '--push');
    expect(run.exitCode, run.output).toBe(0);
    expect(filesAt('main')).toEqual(['.gitignore', 'dist/action.mjs', 'package.json']);
  });

  it('adds the next release as one commit on top, deleting what the tree no longer has', async () => {
    const { remote, tree, sync, filesAt } = bed();
    await sync(tree('one', '0.1.0', { 'old.md': 'old\n', 'README.md': 'one\n' }), '--push');
    const first = git(remote, 'rev-parse', 'main');
    const run = await sync(tree('two', '0.2.0', { 'README.md': 'two\n' }), '--push');
    expect(run.exitCode, run.output).toBe(0);
    expect(filesAt('v0.2.0')).toEqual(['README.md', 'package.json']);
    expect(git(remote, 'log', '--format=%s', 'main').split('\n')).toEqual([
      'sealup v0.2.0',
      'sealup v0.1.0',
    ]);
    expect(git(remote, 'rev-parse', 'main^')).toBe(first);
    expect(git(remote, 'show', 'main:README.md')).toBe('two');
  });

  it('does nothing when the tag is already published with the same tree (a rerun)', async () => {
    const { remote, tree, sync } = bed();
    const folder = tree('one', '0.1.0', { 'README.md': 'one\n' });
    await sync(folder, '--push');
    const before = git(remote, 'rev-parse', 'main');
    const run = await sync(folder, '--push');
    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('v0.1.0 is already published with this tree; nothing to push');
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
  });

  it('stops when the tag is already published with another tree', async () => {
    const { remote, tree, sync } = bed();
    await sync(tree('one', '0.1.0', { 'README.md': 'one\n' }), '--push');
    const before = git(remote, 'rev-parse', 'main');
    const run = await sync(tree('other', '0.1.0', { 'README.md': 'other\n' }), '--push');
    expect(run.exitCode, run.output).toBe(1);
    expect(run.output).toContain('v0.1.0 is already published with another tree');
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
  });

  it('pushes nothing without --push (the dry run)', async () => {
    const { remote, tree, sync } = bed();
    const run = await sync(tree('one', '0.1.0', { 'README.md': 'one\n' }));
    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toMatch(/dry run, made [0-9a-f]{12} and v0\.1\.0; nothing pushed/);
    expect(git(remote, 'for-each-ref')).toBe('');
  });

  it.each([
    ['a version that is not X.Y.Z', '0.1.0-beta.1', [], 1, "package.json's version must be X.Y.Z"],
    ['an author with no email', '0.1.0', ['--author', 'nobody'], 2, '--author must read'],
  ] as const)('refuses %s', async (_, version, more, exitCode, message) => {
    const { remote, tree, sync } = bed();
    const run = await sync(tree('one', version, {}), ...more);
    expect(run.exitCode, run.output).toBe(exitCode);
    expect(run.output).toContain(message);
    expect(git(remote, 'for-each-ref')).toBe('');
  });
});
