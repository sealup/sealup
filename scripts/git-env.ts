// The environment for every git the scripts and tests start. A git hook runs with git's own
// variables set (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, GIT_PREFIX, an author when it has one),
// and the pre-commit hook runs the gates, so a git started under it inherits them: pointed at a
// temp repo, it acts on the repo being committed instead (its index taken and wiped). Without
// them, git finds its repo from its folder or its flags, as it does in a terminal.

/** What `git rev-parse --local-env-vars` lists (git 2.55): each points git at one repo's files. */
const repoVariables: ReadonlySet<string> = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/** The `-c` pairs a hook passes on (GIT_CONFIG_KEY_<n>), and the author a commit passes on. */
const handedDown = /^GIT_(CONFIG_(KEY|VALUE)_\d+|AUTHOR_\w+|COMMITTER_\w+)$/;

/**
 * `process.env` without the git variables a hook hands down, then `extra` on top. Names are
 * compared in upper case: Windows' are not case-sensitive.
 */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (!repoVariables.has(upper) && !handedDown.test(upper)) env[name] = value;
  }
  return { ...env, ...extra };
}
