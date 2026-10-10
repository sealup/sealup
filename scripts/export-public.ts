// Writes the public tree (decision 0035) to a folder for inspection: the committed files
// (`git ls-files`, read only) kept by scripts/public-tree.ts's allow-list, scanned for denied
// strings. Any problem stops it before anything is written. No commit, no push, no network.
//
//   node scripts/export-public.ts <folder> [--release] [--names <file>]
//   node scripts/export-public.ts --scan [--names <file>] <file...>
//   node scripts/export-public.ts --touches <base>
//
// <folder>   must not exist yet, or be empty
// --release  the names list must be there, with at least one name
// --names    the names list (default: .private-names at the repo root, git-ignored): client names
//            and the owner's other projects, one per line, `#` for comments; names only
// --scan     scans the given files as they are, with no allow-list and no fixture excuse (the
//            proven-to-bite test, test/gates/export.test.ts)
// --touches  prints `true` when the commits from <base> to HEAD, in the repo it runs in, change
//            a path the export keeps (or a workflow in neither list; a move counts both paths),
//            else `false`; `true` when <base> is not in the history. The private repo's CI skips
//            its release dry run on `false` (ruling 10).
//
// Exit 0 when the tree is clean, 1 on any problem (one line each: place and kind, never the
// string), 2 on a usage error. Contents come from the working tree: run it on a clean checkout.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { repoRoot } from './gates.ts';
import { gitEnv } from './git-env.ts';
import { parseNames, publicTree, scanFiles, touchesPublicTree } from './public-tree.ts';

interface Options {
  readonly folder: string | undefined;
  readonly files: readonly string[];
  readonly scan: boolean;
  readonly release: boolean;
  readonly names: string;
}

function parseArgs(args: readonly string[]): Options | string {
  const positional: string[] = [];
  let scan = false;
  let release = false;
  let names = join(repoRoot, '.private-names');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--scan') scan = true;
    else if (arg === '--release') release = true;
    else if (arg === '--names') {
      const value = args[++i];
      if (value === undefined) return '--names needs a file';
      names = resolve(value);
    } else if (arg.startsWith('--')) return `unknown option ${arg}`;
    else positional.push(arg);
  }
  if (scan) {
    if (positional.length === 0) return '--scan needs at least one file';
    return { folder: undefined, files: positional, scan, release, names };
  }
  if (positional.length !== 1) return 'give one output folder';
  const folder = resolve(positional[0] ?? '');
  if (existsSync(folder) && readdirSync(folder).length > 0) {
    return `${folder} is not empty; give a new or empty folder`;
  }
  return { folder, files: [], scan, release, names };
}

const readNames = (file: string): string[] | undefined =>
  existsSync(file) ? parseNames(readFileSync(file, 'utf8')) : undefined;

const committedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', env: gitEnv() })
    .split('\0')
    .filter((path) => path !== '');

function run(options: Options): number {
  const sources = new Map<string, string>(
    options.scan
      ? options.files.map((file) => [
          relative(repoRoot, resolve(file)).replaceAll('\\', '/'),
          resolve(file),
        ])
      : committedFiles().map((path) => [path, join(repoRoot, path)]),
  );
  const input = {
    paths: [...sources.keys()],
    read: (path: string) => readFileSync(sources.get(path) ?? '', 'utf8'),
    names: readNames(options.names),
    release: options.release,
  };
  const tree = options.scan ? scanFiles(input) : publicTree(input);
  for (const note of tree.notes) console.error(`note: ${note}`);
  for (const error of tree.errors) console.error(error);
  if (!tree.ok) {
    console.error(`export: stopped, ${tree.errors.length} problem(s); nothing written`);
    return 1;
  }
  if (options.folder === undefined) {
    console.error(`export: ${tree.files.length} file(s) scanned, clean`);
    return 0;
  }
  for (const path of tree.files) {
    const target = join(options.folder, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sources.get(path) ?? '', target);
  }
  console.error(`export: ${tree.files.length} public file(s) written to ${options.folder}`);
  return 0;
}

/**
 * `--touches <base>`: whether the commits since `base`, in the repo it runs in, can change the
 * export.
 */
function touches(base: string): boolean {
  let changed: string[];
  try {
    // --no-renames: a moved file is listed under both paths, so a public file moved into a
    // private folder still counts as a public change (its public copy is deleted).
    const args = ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--'];
    changed = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(),
    })
      .split('\0')
      .filter((path) => path !== '');
  } catch {
    console.error(`note: no commit ${base} to compare with; counting the change as public`);
    return true;
  }
  return touchesPublicTree(changed);
}

if (import.meta.main && process.argv[2] === '--touches') {
  const base = process.argv[3];
  if (base === undefined || base === '' || process.argv.length > 4) {
    console.error('export: --touches needs a base commit');
    console.error('usage: node scripts/export-public.ts --touches <base>');
    process.exitCode = 2;
  } else {
    console.log(String(touches(base)));
  }
} else if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    console.error(`export: ${options}`);
    console.error('usage: node scripts/export-public.ts <folder> [--release] [--names <file>]');
    console.error('       node scripts/export-public.ts --scan [--names <file>] <file...>');
    process.exitCode = 2;
  } else {
    process.exitCode = run(options);
  }
}
