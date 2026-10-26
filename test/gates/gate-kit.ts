// Helpers for the proven-to-bite tests. Each bad file in test/gates/bad/<gate>/ starts with
// three header lines:
//
//   // Bites: <the rule it breaks, in words>
//   // Placed at: <repo-relative path where the file goes in the temp project>
//   // Expect: <text the gate prints for this file, e.g. TS7006 or lint/suspicious/noFocusedTests>
//
// A test copies the repo's real config files and the bad files into a temp project, runs the
// real gate command there (scripts/gates.ts), and checks the gate fails and names each file.

import { execFile } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GateName, gateArgs, repoRoot } from '../../scripts/gates.ts';

/** A file of a temp project. */
export interface ProjectFile {
  readonly placedAt: string;
  readonly content: string;
}

interface BadFile extends ProjectFile {
  readonly name: string;
  readonly bites: string;
  readonly expect: string;
}

export interface GateRun {
  readonly exitCode: number;
  /** stdout and stderr together, with Windows separators turned into `/`. */
  readonly output: string;
}

const header = (content: string, key: string, file: string): string => {
  const match = new RegExp(`^// ${key}: (.+)$`, 'm').exec(content);
  if (match?.[1] === undefined) throw new Error(`${file}: missing "// ${key}:" header line`);
  return match[1].trim();
};

function loadBadFiles(gate: string): BadFile[] {
  const folder = join(repoRoot, 'test', 'gates', 'bad', gate);
  return readdirSync(folder)
    .sort()
    .map((name) => {
      const content = readFileSync(join(folder, name), 'utf8');
      return {
        name,
        bites: header(content, 'Bites', name),
        placedAt: header(content, 'Placed at', name),
        expect: header(content, 'Expect', name),
        content,
      };
    });
}

const configFiles = [
  'package.json',
  '.gitignore',
  'tsconfig.json',
  'biome.json',
  'knip.json',
  'vitest.config.ts',
];

/**
 * A temp project with the repo's real config files, `node_modules` linked (a junction on
 * Windows, so no admin rights are needed) and the given files. Returns its folder.
 */
export function makeProject(files: readonly ProjectFile[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sealup-gate-'));
  try {
    for (const name of configFiles) cpSync(join(repoRoot, name), join(root, name));
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
    for (const file of files) {
      const target = join(root, ...file.placedAt.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    return root;
  } catch (error) {
    removeProject(root);
    throw error;
  }
}

/** Removes a temp project; the `node_modules` junction is unlinked, never followed. */
export function removeProject(root: string | undefined): void {
  if (root === undefined) return;
  try {
    unlinkSync(join(root, 'node_modules'));
  } catch {
    // not linked yet
  }
  rmSync(root, { recursive: true, force: true });
}

/**
 * The proven-to-bite suite of one gate: all its bad files in one temp project, one run of the
 * gate, then one test per bad file asserting that a line of the output names the file and the
 * expected rule.
 */
export function provenToBite(gate: GateName, folder: string): void {
  const badFiles = loadBadFiles(folder);

  describe(`${gate}, proven to bite`, () => {
    let project: string | undefined;
    let run: GateRun = { exitCode: 0, output: '' };

    beforeAll(async () => {
      project = makeProject(badFiles);
      run = await runGate(gate, project);
    });
    afterAll(() => removeProject(project));

    it('fails on the bad files', () => {
      expect(run.exitCode).not.toBe(0);
    });

    it.each(badFiles)('$name: $bites', (bad) => {
      const lines = run.output.split('\n').filter((line) => line.includes(bad.placedAt));
      expect(
        lines.some((line) => line.includes(bad.expect)),
        lines.join('\n') || run.output,
      ).toBe(true);
    });
  });
}

/** Runs one gate, exactly as `check.ts` does, in `cwd`. */
export function runGate(name: GateName, cwd: string): Promise<GateRun> {
  return runNode(gateArgs(name), cwd);
}

/** Runs `node <args>` in `cwd`, with `input` on stdin when given. */
export function runNode(
  args: readonly string[],
  cwd: string,
  input?: string,
  env: NodeJS.ProcessEnv = {},
): Promise<GateRun> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      args,
      {
        cwd,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ exitCode, output: `${stdout}\n${stderr}`.replaceAll('\\', '/') });
      },
    );
    child.stdin?.end(input ?? '');
  });
}
