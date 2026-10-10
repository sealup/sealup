// Golden S01, "No config yet" (CLI page, docs/exploration/assets/06/scenarios-start-daily.js).
// `sealup` alone in a project without sealup.yml, exit 0: where it looked, and the one command
// that starts the setup. Same text in CI: it never prompts and never connects (spec #24
// decision 12). It is help, so it goes to stdout like `sealup help` (decision 13), and a log form
// adds no version line: the first line is one.
//
// Adapted: a folder outside any git repo is the only folder searched, so its second line says
// so (the page's line is the repo case).

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import { inGitHub, runMain } from '../../deploy-kit.ts';

const s01 = (looked: string) => [
  '  sealup 0.0.0-source · no sealup.yml found',
  '',
  `  ${looked}`,
  '',
  '  Set up this project:  {b}sealup init{/}',
  '  {d}It asks for the server address and writes the rest.{/}',
  '',
  '  All commands:         sealup help',
];
const inRepo = 'Looked in this folder and in each folder above it, up to the repo root.';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** An empty project folder, `src/app` inside a repo (`.git`) or a bare folder outside one. */
function emptyProject(repo: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'sealup project '));
  folders.push(root);
  if (!repo) return root;
  mkdirSync(join(root, '.git'));
  const cwd = join(root, 'src', 'app');
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

describe('S01: no config yet', () => {
  it('prints the page lines on a terminal, on stdout, exit 0', async () => {
    // No server: a run that connects fails the test.
    const run = await runMain([], { cwd: emptyProject(true), tty: true });
    expect(run.stdout).toBe(goldenText(s01(inRepo), { color: true }));
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
  });

  it('prints the same text in a log and in GitHub, without colour', async () => {
    for (const env of [{}, inGitHub]) {
      const run = await runMain([], { cwd: emptyProject(true), env });
      expect(run.stdout).toBe(goldenText(s01(inRepo), { color: false }));
      expect(run.stderr).toBe('');
      expect(run.exitCode).toBe(0);
    }
  });

  it('says it looked in this folder only outside a git repo', async () => {
    const run = await runMain([], { cwd: emptyProject(false) });
    expect(run.stdout).toBe(goldenText(s01('Looked in this folder.'), { color: false }));
    expect(run.exitCode).toBe(0);
  });
});
