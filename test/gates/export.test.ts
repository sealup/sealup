// The public export (decision 0035), proven to bite: each bad file in test/gates/bad/export/
// plants one kind of private string and fails scripts/export-public.ts --scan, naming its place
// and kind but never the string; the repo's own tree exports clean, keeping only public paths.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { gitEnv } from '../../scripts/git-env.ts';
import { runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'export-public.ts');
const folder = join(repoRoot, 'test', 'gates', 'bad', 'export');

const badFiles = readdirSync(folder)
  .sort()
  .map((name) => {
    const content = readFileSync(join(folder, name), 'utf8');
    return {
      name,
      kind: /^# Expect: (.+)$/m.exec(content)?.[1]?.trim() ?? '',
      planted: content.split('\n').filter((line) => line !== '' && !line.startsWith('#')),
    };
  });

describe('the export, proven to bite', () => {
  let temp = '';
  // One scan of all the bad files, as the gate-kit's suites do: one process, not one per file.
  let scan = { exitCode: 0, output: '' };
  beforeAll(async () => {
    temp = mkdtempSync(join(tmpdir(), 'sealup-export-'));
    // A synthetic names list, as the owner's git-ignored file would hold real ones.
    const names = join(temp, 'names.txt');
    writeFileSync(names, '# clients\nAcme Bakery\n');
    const files = badFiles.map((file) => join(folder, file.name));
    scan = await runNode([script, '--scan', '--names', names, ...files], repoRoot);
  });
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('has one bad file per kind of private string', () => {
    expect(badFiles.map((file) => file.kind)).toEqual([
      'bench-folder',
      'local-drive-path',
      'ovh-cluster-host',
      'private-name',
    ]);
  });

  it('fails on the bad files', () => {
    expect(scan.exitCode, scan.output).toBe(1);
  });

  it.each(badFiles)('$name fails with $kind, and only that', ({ name, kind, planted }) => {
    const hits = scan.output.split('\n').filter((line) => line.includes(`/${name}`));
    expect(hits).toEqual([
      expect.stringMatching(new RegExp(`^test/gates/bad/export/${name}:\\d+:\\d+ ${kind}$`)),
    ]);
    for (const line of planted) expect(scan.output).not.toContain(line.trim());
  });

  it('exports the repo clean, with only the public paths', async () => {
    const out = join(temp, 'public');
    const run = await runNode([script, out], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toMatch(/export: \d+ public file\(s\) written to /);
    for (const path of ['src/cli/index.ts', 'action.yml', 'dist/action.mjs', 'README.md']) {
      expect(existsSync(join(out, path)), path).toBe(true);
    }
    for (const path of ['docs', 'spikes', 'tools', 'AGENTS.md', '.claude']) {
      expect(existsSync(join(out, path)), path).toBe(false);
    }
  });

  it('fails a release with no names list, and writes nothing', async () => {
    const out = join(temp, 'release');
    const run = await runNode(
      [script, out, '--release', '--names', join(temp, 'absent.txt')],
      repoRoot,
    );
    expect(run.exitCode, run.output).toBe(1);
    expect(run.output).toContain(
      "No names list: a release checks client names and the owner's other projects.",
    );
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a folder that is not empty', async () => {
    const out = join(temp, 'full');
    mkdirSync(out);
    writeFileSync(join(out, 'keep.txt'), 'kept');
    const run = await runNode([script, out], repoRoot);
    expect(run.exitCode, run.output).toBe(2);
    expect(run.output).toContain('is not empty; give a new or empty folder');
    expect(readdirSync(out)).toEqual(['keep.txt']);
  });
});

// The private repo's CI asks it whether a change can alter the public tree, and skips the release
// dry run when it cannot (ruling 10). Answers on stdout: `true` or `false`.
describe('--touches <base>', () => {
  /** git's empty tree: from it, every committed file is a change. */
  const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const answer = (output: string): string => output.split('\n')[0] ?? '';

  /** Git in `cwd`, with no user or system config, so the owner's settings never change a result. */
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: gitEnv({ GIT_CONFIG_GLOBAL: '', GIT_CONFIG_NOSYSTEM: '1' }),
    }).trim();

  /**
   * A repo of its own holding a public test and a private note, then one more commit made by
   * `change`; the answer for that commit, from the repo it is asked in.
   */
  async function touchesAfter(change: (repo: string) => void): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), 'sealup-touches-'));
    try {
      git(repo, 'init', '--quiet', '--initial-branch=main');
      git(repo, 'config', 'user.name', 'sealup test');
      git(repo, 'config', 'user.email', 'test@example.com');
      mkdirSync(join(repo, 'test', 'unit'), { recursive: true });
      mkdirSync(join(repo, 'test', 'private'), { recursive: true });
      mkdirSync(join(repo, 'docs'));
      writeFileSync(join(repo, 'test', 'unit', 'x.test.ts'), 'export const x = 1;\n');
      writeFileSync(join(repo, 'docs', 'notes.md'), '# Notes\n');
      git(repo, 'add', '--all');
      git(repo, 'commit', '--quiet', '-m', 'first');
      change(repo);
      git(repo, 'commit', '--quiet', '-m', 'second');
      const run = await runNode([script, '--touches', 'HEAD~1'], repo);
      expect(run.exitCode, run.output).toBe(0);
      expect(run.output).not.toContain('note:');
      return answer(run.output);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // The pair proves it asks the repo it runs in: whatever this repo's last commit holds, one of
  // them would fail if it asked this one.
  it('says true when a public file changes in the repo it runs in', async () => {
    const answered = await touchesAfter((repo) => {
      writeFileSync(join(repo, 'test', 'unit', 'x.test.ts'), 'export const x = 2;\n');
      git(repo, 'add', '--all');
    });
    expect(answered).toBe('true');
  });

  it('says false when only docs change in the repo it runs in', async () => {
    const answered = await touchesAfter((repo) => {
      writeFileSync(join(repo, 'docs', 'notes.md'), '# Notes\n\nOne more line.\n');
      git(repo, 'add', '--all');
    });
    expect(answered).toBe('false');
  });

  // A move into a private folder deletes the public file: the public copy changes, though the
  // new path alone is private.
  it('says true when a public file moves into a private folder', async () => {
    const answered = await touchesAfter((repo) => {
      git(repo, 'mv', 'test/unit/x.test.ts', 'test/private/x.test.ts');
    });
    expect(answered).toBe('true');
  });

  it('says false when nothing changed since the base', async () => {
    const run = await runNode([script, '--touches', 'HEAD'], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
    expect(answer(run.output)).toBe('false');
  });

  it('says true when public files changed since the base', async () => {
    const run = await runNode([script, '--touches', emptyTree], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
    expect(answer(run.output)).toBe('true');
  });

  it('says true, with a note, when the base is not in the history (a force push, a new branch)', async () => {
    const run = await runNode([script, '--touches', '0'.repeat(40)], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
    expect(answer(run.output)).toBe('true');
    expect(run.output).toContain(`note: no commit ${'0'.repeat(40)} to compare with`);
  });

  it('needs a base', async () => {
    const run = await runNode([script, '--touches'], repoRoot);
    expect(run.exitCode, run.output).toBe(2);
    expect(run.output).toContain('--touches needs a base commit');
  });
});
