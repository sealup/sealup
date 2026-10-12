// check-dist (decision 0011), proven to bite: a committed bundle that differs from a fresh build
// fails, naming the file. Wired to CI when the action bundle lands (lane C).

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from '../../scripts/build.ts';
import { repoRoot } from '../../scripts/gates.ts';
import { gitEnv } from '../../scripts/git-env.ts';
import { makeProject, removeProject, runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'check-dist.ts');

describe.concurrent('check-dist, proven to bite', () => {
  let root = '';
  const committed = (): string => join(root, 'committed');
  const fresh = (): string => join(root, 'fresh');
  const check = (...files: string[]) =>
    runNode([script, '--committed', committed(), '--fresh', fresh(), ...files], root);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sealup-check-dist-'));
    mkdirSync(committed());
    mkdirSync(fresh());
    const bundle = 'const a = 1;\nconsole.log(a);\n';
    writeFileSync(join(committed(), 'same.mjs'), bundle);
    writeFileSync(join(fresh(), 'same.mjs'), bundle);
    writeFileSync(join(committed(), 'edited.mjs'), 'const a = 1;\nconsole.log(a, "by hand");\n');
    writeFileSync(join(fresh(), 'edited.mjs'), bundle);
    writeFileSync(join(fresh(), 'uncommitted.mjs'), bundle);
    writeFileSync(join(committed(), 'stale.mjs'), bundle);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('passes a committed bundle equal to the fresh build', async () => {
    const run = await check('same.mjs');
    expect(run.exitCode, run.output).toBe(0);
  });

  it('fails a committed bundle edited by hand, naming the file and the first line that differs', async () => {
    const run = await check('same.mjs', 'edited.mjs');
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('edited.mjs differs from a fresh build (first at line 2)');
    expect(run.output).not.toContain('same.mjs differs');
  });

  it('fails a bundle the build makes but nobody committed', async () => {
    const run = await check('uncommitted.mjs');
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('uncommitted.mjs is not committed');
  });

  it('fails a committed bundle the build no longer makes', async () => {
    const run = await check('stale.mjs');
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('stale.mjs is not made by the build');
  });
});

describe('check-dist, on the real build', () => {
  // The repo's own build, made once: the release tests below compare against it too.
  let committed = '';
  beforeAll(async () => {
    committed = mkdtempSync(join(tmpdir(), 'sealup-check-dist-real-'));
    await build({ outdir: committed });
  });
  afterAll(() => rmSync(committed, { recursive: true, force: true }));

  it('passes, because the build gives the same bytes every time', async () => {
    const run = await runNode(
      [script, '--committed', committed, 'cli.mjs', 'action.mjs'],
      repoRoot,
    );
    expect(run.exitCode, run.output).toBe(0);
  });

  // Spec #41 decision 34: a release PR bumps `version` and nothing else, so check-dist must stay
  // green through it. One release build, run in a copy of the repo whose package.json says
  // another version. Since 0043 no bundle carries the release commit either.
  describe('through a release', () => {
    let copy: string | undefined;
    const out = (): string => join(copy ?? '', 'out');
    beforeAll(async () => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as object;
      const content = JSON.stringify({ ...pkg, version: '9.8.7' }, null, 2);
      copy = makeProject([{ placedAt: 'package.json', content }]);
      for (const folder of ['src', 'scripts']) {
        cpSync(join(repoRoot, folder), join(copy, folder), { recursive: true });
      }
      const built = await runNode([join(copy, 'scripts', 'build.ts'), '--outdir', out()], copy);
      expect(built.exitCode, built.output).toBe(0);
    });
    afterAll(() => removeProject(copy));

    it('passes both bundles built with another version', async () => {
      const run = await runNode(
        [script, '--committed', out(), '--fresh', committed, 'action.mjs', 'cli.mjs'],
        repoRoot,
      );
      expect(run.exitCode, run.output).toBe(0);
    });
  });
});

// The action's bundle is committed (spec #24 decision 35): out of .gitignore's dist/, and never
// text to git, so no checkout changes a line ending and check-dist compares the built bytes.
describe('the committed action bundle', () => {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', env: gitEnv() }).trim();

  it('is tracked, while the rest of dist/ stays ignored', () => {
    expect(git('ls-files', 'dist')).toBe('dist/action.mjs');
    expect(git('check-ignore', '--no-index', 'dist/cli.mjs')).toBe('dist/cli.mjs');
  });

  it('is not text: no line ending is ever changed', () => {
    // With text unset, git leaves the bytes alone whatever `eol` says.
    expect(git('check-attr', 'text', '--', 'dist/action.mjs')).toBe('dist/action.mjs: text: unset');
  });
});
