// Git under a hook's environment: the pre-commit hook runs the gates with GIT_DIR, GIT_INDEX_FILE
// and GIT_WORK_TREE set to the repo being committed. Here they point at a sacrificial repo, and
// the scripts that start git must leave its index and refs exactly as they were.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { gitEnv } from '../../scripts/git-env.ts';
import { runNode } from './gate-kit.ts';

const author = 'sealup-release[bot] <1+sealup-release[bot]@users.noreply.github.com>';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnv({
      GIT_CONFIG_GLOBAL: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    }),
  }).trim();

describe("git under a hook's environment", () => {
  let temp = '';
  let sacrificial = '';
  let before = '';

  /** The sacrificial repo's index bytes, refs and status: what a stray git would change. */
  const state = (): string =>
    [
      createHash('sha256')
        .update(readFileSync(join(sacrificial, '.git', 'index')))
        .digest('hex'),
      git(sacrificial, 'for-each-ref'),
      git(sacrificial, 'status', '--porcelain'),
    ].join('\n');

  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), 'sealup-git-env-'));
    sacrificial = join(temp, 'sacrificial');
    mkdirSync(sacrificial);
    git(sacrificial, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(sacrificial, 'kept.txt'), 'kept\n');
    git(sacrificial, 'add', 'kept.txt');
    git(sacrificial, 'commit', '--quiet', '-m', 'first');
    writeFileSync(join(sacrificial, 'staged.txt'), 'staged\n');
    git(sacrificial, 'add', 'staged.txt');
    before = state();
    vi.stubEnv('GIT_DIR', join(sacrificial, '.git'));
    vi.stubEnv('GIT_INDEX_FILE', join(sacrificial, '.git', 'index'));
    vi.stubEnv('GIT_WORK_TREE', sacrificial);
    vi.stubEnv('GIT_PREFIX', '');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  });

  it('the public sync pushes to its own remote and leaves the hook repo alone', async () => {
    const remote = join(temp, 'public.git');
    git(temp, 'init', '--bare', '--quiet', remote);
    const tree = join(temp, 'tree');
    mkdirSync(tree);
    writeFileSync(join(tree, 'package.json'), '{"name":"sealup","version":"0.1.0"}\n');
    writeFileSync(join(tree, 'README.md'), '# sealup\n');
    const script = join(repoRoot, 'scripts', 'public-sync.ts');
    const run = await runNode(
      [script, tree, '--remote', remote, '--author', author, '--push'],
      repoRoot,
    );
    expect(run.exitCode, run.output).toBe(0);
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort()).toEqual([
      'README.md',
      'package.json',
    ]);
    expect(state()).toBe(before);
  });

  it("the export reads this repo's committed files and leaves the hook repo alone", async () => {
    const out = join(temp, 'public');
    const run = await runNode([join(repoRoot, 'scripts', 'export-public.ts'), out], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
    expect(existsSync(join(out, 'src', 'cli', 'index.ts'))).toBe(true);
    expect(state()).toBe(before);
  });
});
