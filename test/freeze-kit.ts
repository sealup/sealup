// The freeze test's helpers (decision 0026): what a frozen seam looks like now, compared
// with its golden. The seams' goldens live in test/integration/goldens/seams/, so a change to one
// shows up in the pull request's "Needs your look" as a frozen seam.
//
// A golden that no longer matches fails with the seam's name and the rule of decision 0026:
// update the golden on purpose, and say so in the pull request. To rewrite the goldens from what
// the code does now, run the tests with SEALUP_UPDATE_GOLDENS=1, then read the diff.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { expect } from 'vitest';
import { repoRoot, tools } from '../scripts/gates.ts';

/** The folder of the frozen seams' goldens. */
export const seamGoldens: string = join(repoRoot, 'test', 'integration', 'goldens', 'seams');
/** The same folder as a failure names it: relative to the repo, with `/`. */
const shownGoldens = relative(repoRoot, seamGoldens).replaceAll('\\', '/');

/** The message of a frozen seam's failure: the seam and the rule. */
function frozenRule(seam: string, golden: string): string {
  return (
    `Frozen seam changed: ${seam} (decision 0026). If this change is meant, update ${golden} on ` +
    'purpose and say so in the pull request; a breaking change needs a decision record.'
  );
}

/**
 * Fails, naming the seam and the rule, unless `actual` is the golden's text byte for byte.
 * `golden` is a file name in `seamGoldens`, never a path. With SEALUP_UPDATE_GOLDENS=1 (and
 * `update` not turned off), the golden is rewritten instead.
 */
export function expectFrozen(
  seam: string,
  actual: string,
  golden: string,
  options: { readonly update?: boolean } = {},
): void {
  if (golden !== basename(golden)) {
    throw new RangeError(`a seam golden is a file name in ${seamGoldens}, not a path: ${golden}`);
  }
  const file = join(seamGoldens, golden);
  if (options.update ?? process.env.SEALUP_UPDATE_GOLDENS === '1') {
    writeFileSync(file, actual);
    return;
  }
  const rule = frozenRule(seam, `${shownGoldens}/${golden}`);
  if (!existsSync(file)) expect.fail(`${rule} The golden is missing.`);
  expect(actual, rule).toBe(readFileSync(file, 'utf8'));
}

/**
 * The `--json` object on `stdout` against its golden, keys in their order: the object is one line
 * on stdout; the golden holds it laid out, two spaces deep, so a changed key reads as one line.
 */
export function expectFrozenJson(
  run: string,
  stdout: string,
  golden: string,
  options: { readonly update?: boolean } = {},
): void {
  expect(stdout.endsWith('}\n') && stdout.indexOf('\n') === stdout.length - 1, stdout).toBe(true);
  const laidOut = `${JSON.stringify(JSON.parse(stdout), null, 2)}\n`;
  expectFrozen(`the --json object of ${run}`, laidOut, golden, options);
}

/** The exit codes as exit-codes.golden holds them: the table, two spaces deep. */
export const exitCodesText = (codes: Readonly<Record<string, number>>): string =>
  `${JSON.stringify(codes, null, 2)}\n`;

/** The docs slugs as docs-slugs.golden holds them: one a line. */
export const docsSlugsText = (slugs: readonly string[]): string => `${slugs.join('\n')}\n`;

/**
 * The files of the shape snapshot, relative to the root: every file of `contracts` (its entry,
 * then one file per concern), then `plan`'s entry. A file added to `contracts` goes here too, or
 * `expectContractsInShape` fails.
 */
const shapeFiles: readonly string[] = [
  'src/contracts/index.ts',
  'src/contracts/brands.ts',
  'src/contracts/session.ts',
  'src/contracts/config.ts',
  'src/contracts/plan.ts',
  'src/contracts/run.ts',
  'src/contracts/pull.ts',
  'src/plan/index.ts',
];

/** A code file, as the import rules count them. */
const codeFile = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/**
 * Fails, naming each file and the rule, unless every code file under `src/contracts/` of `root`
 * (subfolders too) is in `shapeFiles`: a file left out would escape the shape golden.
 */
export function expectContractsInShape(root: string): void {
  const files = readdirSync(join(root, 'src', 'contracts'), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && codeFile.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
  const missing = files.filter((file) => !shapeFiles.includes(file));
  const rule =
    'A file of contracts is missing from the shape snapshot (decision 0026): list it in ' +
    `shapeFiles (test/freeze-kit.ts), so the freeze test covers it. Missing: ${missing.join(', ')}`;
  expect(missing, rule).toEqual([]);
}

/**
 * The public shape of `contracts` and `plan` under `root` (the repo, or a temp copy holding its
 * package.json, tsconfig.json and src/): their declarations as the TypeScript compiler emits
 * them, without comments, each after a `// <file>` line. Comment-only edits leave it as it was.
 */
export async function seamShape(root: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), 'sealup-shape-'));
  try {
    const out = join(work, 'out');
    const config = {
      extends: join(root, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        removeComments: true,
        newLine: 'lf',
        // The temp config sits outside the repo: Node's types come from the repo's packages.
        typeRoots: [join(repoRoot, 'node_modules', '@types')],
        rootDir: join(root, 'src'),
        outDir: out,
      },
      files: shapeFiles.map((file) => join(root, file)),
      include: [],
    };
    const project = join(work, 'tsconfig.json');
    writeFileSync(project, JSON.stringify(config));
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [tools.tsc, '-p', project, '--pretty', 'false'], (error, out) =>
        error === null ? resolve() : reject(new Error(`tsc failed on the shape files:\n${out}`)),
      );
    });
    return shapeFiles
      .map((file) => {
        const emitted = join(out, file.replace(/^src\//, '').replace(/\.ts$/, '.d.ts'));
        return `// ${file}\n${readFileSync(emitted, 'utf8')}`;
      })
      .join('\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
