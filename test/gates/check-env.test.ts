// The gates check the folder they run in, whoever starts them. The pre-commit hook does so with
// git's repo-locating variables set (in a worktree, GIT_DIR and GIT_INDEX_FILE are absolute): a
// test that runs git in a temp repo would then read or write the commit's own repo and index.
// So each step runs without them.

import { afterEach, expect, it } from 'vitest';
import { runStep } from '../../scripts/gates.ts';

const hook = { GIT_DIR: '/hook/repo/.git', GIT_INDEX_FILE: '/hook/repo/.git/index' };
const saved = Object.fromEntries(Object.keys(hook).map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

it('runs each step without the repo and index a git hook names, the rest of the env kept', async () => {
  Object.assign(process.env, hook);

  const run = await runStep('env', [
    '-e',
    "const { GIT_DIR = '-', GIT_INDEX_FILE = '-', PATH } = process.env; console.log(GIT_DIR, GIT_INDEX_FILE, PATH === undefined ? '-' : 'PATH')",
  ]);

  expect(run.output).toBe('- - PATH');
});
