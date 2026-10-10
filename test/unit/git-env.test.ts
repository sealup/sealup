// gitEnv (scripts/git-env.ts): the environment every git the scripts and tests start gets, without
// the variables a git hook hands down.

import { afterEach, expect, it, vi } from 'vitest';
import { gitEnv } from '../../scripts/git-env.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

it("drops a hook's repo, index, -c pairs and author, and keeps the rest", () => {
  const handed = {
    GIT_DIR: '/hook/repo/.git',
    GIT_INDEX_FILE: '/hook/repo/.git/index',
    GIT_WORK_TREE: '/hook/repo',
    GIT_PREFIX: 'src/',
    GIT_CONFIG_PARAMETERS: "'core.hookspath'='.githooks'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '.githooks',
    GIT_AUTHOR_NAME: 'Hook Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_AUTHOR_DATE: '@0 +0000',
    GIT_COMMITTER_NAME: 'Hook Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
  };
  for (const [name, value] of Object.entries(handed)) vi.stubEnv(name, value);
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  vi.stubEnv('SEALUP_KEPT', 'kept');

  const env = gitEnv();

  for (const name of Object.keys(handed)) expect(env, name).not.toHaveProperty(name);
  expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  expect(env.SEALUP_KEPT).toBe('kept');
});

it('matches names whatever their case, as Windows does', () => {
  vi.stubEnv('git_dir', '/hook/repo/.git');
  vi.stubEnv('Git_Index_File', '/hook/repo/.git/index');
  vi.stubEnv('git_author_name', 'Hook Author');

  const names = Object.keys(gitEnv()).map((name) => name.toUpperCase());

  expect(names).not.toContain('GIT_DIR');
  expect(names).not.toContain('GIT_INDEX_FILE');
  expect(names).not.toContain('GIT_AUTHOR_NAME');
});

it('adds extra on top, even a name it drops from the environment', () => {
  vi.stubEnv('GIT_AUTHOR_NAME', 'Hook Author');
  vi.stubEnv('SEALUP_KEPT', 'from the environment');

  const env = gitEnv({
    GIT_AUTHOR_NAME: 'sealup-release[bot]',
    GIT_CONFIG_NOSYSTEM: '1',
    SEALUP_KEPT: 'from extra',
  });

  expect(env.GIT_AUTHOR_NAME).toBe('sealup-release[bot]');
  expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
  expect(env.SEALUP_KEPT).toBe('from extra');
});
