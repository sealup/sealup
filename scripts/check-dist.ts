// check-dist (decision 0011): a committed bundle must be byte for byte what a fresh build makes,
// so nobody can ship code by editing the bundle. The action's `dist/action.mjs` is committed
// (spec #24 decision 35); CI's check job runs this script on it, on Linux and Windows.
//
//   node scripts/check-dist.ts [--committed <folder>] [--fresh <folder>] <file>...
//
// --committed  the folder of the committed bundles (default: dist/)
// --fresh      a folder with a fresh build; when absent, the script builds into a temp folder
// Exit 0 when every named file is the same in both, 1 otherwise, one line per difference.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from './build.ts';
import { repoRoot } from './gates.ts';

function difference(committed: string, fresh: string, file: string): string | undefined {
  const a = join(committed, file);
  const b = join(fresh, file);
  if (!existsSync(b)) return `${file} is not made by the build (remove it from ${committed})`;
  if (!existsSync(a)) return `${file} is not committed (run the build and commit it)`;
  const old = readFileSync(a);
  const now = readFileSync(b);
  if (old.equals(now)) return undefined;
  let at = 0;
  while (at < old.length && at < now.length && old[at] === now[at]) at++;
  const line = old.subarray(0, at).toString('utf8').split('\n').length;
  return `${file} differs from a fresh build (first at line ${line}); rebuild and commit it`;
}

const { values, positionals: files } = parseArgs({
  allowPositionals: true,
  options: { committed: { type: 'string' }, fresh: { type: 'string' } },
});
if (files.length === 0) {
  console.error(
    'usage: node scripts/check-dist.ts [--committed <folder>] [--fresh <folder>] <file>...',
  );
  process.exit(2);
}
const committed = values.committed ?? join(repoRoot, 'dist');
let fresh = values.fresh;
let temp: string | undefined;
if (fresh === undefined) {
  temp = mkdtempSync(join(tmpdir(), 'sealup-fresh-'));
  await build({ outdir: temp });
  fresh = temp;
}
try {
  const problems = files.flatMap((file) => difference(committed, fresh, file) ?? []);
  for (const problem of problems) console.error(problem);
  console.error(
    problems.length === 0
      ? `check-dist: ${files.length} file(s) equal to a fresh build`
      : `check-dist: ${problems.length} problem(s)`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
} finally {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
}
