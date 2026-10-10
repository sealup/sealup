// Finding sealup.yml (decision 0022 §1): `sealup.yml` or `sealup.yaml` in the current folder,
// then in each parent up to the repo root, so another project's file is never picked up.
// The repo root is the nearest folder holding `.git`, a folder or (in a worktree) a file
// (ruling 11). Outside a repo only the current folder is searched. A folder holding both names is
// refused: which one counts would be a guess.

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConfigIssue } from '../contracts/index.ts';

const names = ['sealup.yml', 'sealup.yaml'] as const;

export type FindResult =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export async function findConfig(cwd: string): Promise<FindResult> {
  const root = await findRepoRoot(cwd);
  for (const folder of upTo(cwd, root ?? cwd)) {
    const present: string[] = [];
    for (const name of names) {
      if (await isFile(join(folder, name))) present.push(join(folder, name));
    }
    const [file] = present;
    if (present.length > 1) {
      return {
        ok: false,
        issues: [{ code: 'file-ambiguous', file: join(folder, names[0]), keyPath: '' }],
      };
    }
    if (file !== undefined) return { ok: true, file };
  }
  const issue: ConfigIssue = {
    code: 'file-not-found',
    file: join(cwd, names[0]),
    keyPath: '',
    ...(root === undefined || root === cwd ? {} : { searchedUpTo: root }),
  };
  return { ok: false, issues: [issue] };
}

/** The nearest folder at or above `cwd` that holds `.git`, or undefined outside a repo. */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
  for (const folder of upTo(cwd, undefined)) {
    if (await exists(join(folder, '.git'))) return folder;
  }
  return undefined;
}

/** `from`, then each parent, ending with `to` (or the file system root). */
function* upTo(from: string, to: string | undefined): Generator<string> {
  let folder = from;
  while (true) {
    yield folder;
    const parent = dirname(folder);
    if (folder === to || parent === folder) return;
    folder = parent;
  }
}

/** Whether `path` is a file; a missing path (or one under a file) is not. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Whether a file system error says the path is not there (or sits under a file). */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
