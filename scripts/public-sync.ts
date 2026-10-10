// The public sync (decision 0035; spec #41 decision 35): turns the exported public tree
// (scripts/export-public.ts) into one commit on the public repo's `main`, tagged `vX.Y.Z`, and
// pushes both at once. The private `public-sync` workflow runs it on the merge of the release
// PR (decision 0041); CI runs it on each pull request against a local bare repo (the dry run).
//
//   node scripts/public-sync.ts <tree> --remote <url> --author "<name> <email>" [--push]
//
// <tree>     the exported tree; its package.json gives the version, so the tag is `v<version>`
// --remote   the public repo (a URL, or a local bare repo in the dry run)
// --author   the commit's and the tag's author and committer (the GitHub App's bot in CI)
// --push     push `main` and the tag, atomically; without it, everything is made locally and
//            nothing is pushed
//
// The commit's tree is exactly <tree>: a file gone from it is deleted from the public repo. Its
// parent is the public `main`, so the public history holds one commit per release. Nothing is
// ever forced: if `main` moved meanwhile, the push is refused. Run again for a tag already
// published with the same tree, it does nothing (a rerun of a failed job); with another tree, it
// stops. With SEALUP_PUSH_TOKEN set, git logs in with it (a GitHub App installation token); it
// never appears in a command line. Git runs without the user's or the system's config, so the
// bytes pushed are the tree's bytes on every machine.
//
// Exit 0 when pushed (or already there, or made in a dry run), 1 when it stops, 2 on a usage error.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gitEnv } from './git-env.ts';

interface Options {
  readonly tree: string;
  readonly remote: string;
  readonly name: string;
  readonly email: string;
  readonly push: boolean;
}

function options(argv: readonly string[]): Options | string {
  let parsed: ReturnType<typeof parse>;
  const parse = (args: string[]) =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        remote: { type: 'string' },
        author: { type: 'string' },
        push: { type: 'boolean', default: false },
      },
    });
  try {
    parsed = parse([...argv]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return 'give one tree folder';
  if (values.remote === undefined) return '--remote is required';
  const author = /^(.+?)\s*<([^<>\s]+)>$/.exec(values.author ?? '');
  if (author?.[1] === undefined || author[2] === undefined) {
    return '--author must read "<name> <email>"';
  }
  const tree = resolve(positionals[0] ?? '');
  if (!existsSync(join(tree, 'package.json'))) return `${tree} holds no package.json`;
  return { tree, remote: values.remote, name: author[1], email: author[2], push: values.push };
}

class Stop extends Error {}

function sync(o: Options): string {
  const version = (
    JSON.parse(readFileSync(join(o.tree, 'package.json'), 'utf8')) as {
      version?: unknown;
    }
  ).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Stop(`package.json's version must be X.Y.Z, not ${JSON.stringify(version)}`);
  }
  const tag = `v${version}`;
  const work = mkdtempSync(join(tmpdir(), 'sealup-public-sync-'));
  try {
    const empty = join(work, 'empty-config');
    const env = gitEnv({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: empty,
      GIT_AUTHOR_NAME: o.name,
      GIT_AUTHOR_EMAIL: o.email,
      GIT_COMMITTER_NAME: o.name,
      GIT_COMMITTER_EMAIL: o.email,
      GIT_TERMINAL_PROMPT: '0',
    });
    const login =
      process.env.SEALUP_PUSH_TOKEN === undefined
        ? []
        : [
            '-c',
            'credential.helper=',
            '-c',
            'credential.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$SEALUP_PUSH_TOKEN"; }; f',
          ];
    const gitDir = join(work, 'public.git');
    const git = (...args: string[]): string =>
      execFileSync(
        'git',
        [
          ...login,
          '-c',
          'core.autocrlf=false',
          `--git-dir=${gitDir}`,
          `--work-tree=${o.tree}`,
          ...args,
        ],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', gitDir], { env });

    const heads = new Map(
      git('ls-remote', o.remote, 'refs/heads/main', `refs/tags/${tag}`)
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const [sha = '', ref = ''] = line.split('\t');
          return [ref, sha] as const;
        }),
    );

    git('add', '--all', '--force');
    const files = git('write-tree');

    if (heads.has(`refs/tags/${tag}`)) {
      git(
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        o.remote,
        `refs/tags/${tag}:refs/tags/${tag}`,
      );
      if (git('rev-parse', `${tag}^{tree}`) === files) {
        return `public sync: ${tag} is already published with this tree; nothing to push`;
      }
      throw new Stop(`${tag} is already published with another tree; release a new version`);
    }

    const parent = heads.get('refs/heads/main');
    if (parent !== undefined) {
      git(
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        o.remote,
        'refs/heads/main:refs/heads/main',
      );
    }
    const title = `sealup ${tag}`;
    const commit = git(
      'commit-tree',
      files,
      ...(parent === undefined ? [] : ['-p', parent]),
      '-m',
      title,
    );
    git('tag', '--annotate', tag, '-m', title, commit);

    if (!o.push) {
      return `public sync: dry run, made ${commit.slice(0, 12)} and ${tag}; nothing pushed`;
    }
    git(
      'push',
      '--atomic',
      '--quiet',
      o.remote,
      `${commit}:refs/heads/main`,
      `refs/tags/${tag}:refs/tags/${tag}`,
    );
    return `public sync: pushed main (${commit.slice(0, 12)}) and ${tag}`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const parsed = options(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`public sync: ${parsed}`);
    console.error(
      'usage: node scripts/public-sync.ts <tree> --remote <url> --author "<name> <email>" [--push]',
    );
    process.exitCode = 2;
  } else {
    try {
      console.error(sync(parsed));
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const why = error instanceof Stop ? error.message : `git failed: ${String(stderr ?? error)}`;
      console.error(`public sync: stopped, ${why.trim()}`);
      process.exitCode = 1;
    }
  }
}
