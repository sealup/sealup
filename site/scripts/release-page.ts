// The release facts the site prints, written at each build (spec sealup/sealup#41 decision 40,
// story 96, I-088): the GitHub Action page's step, pinned to the release commit's full SHA with
// its tag in a comment (as `sealup init` writes it, decision 38), and the verify commands of the
// version built (as SECURITY.md and the release notes give them).
//
//   node scripts/release-page.ts    writes src/generated/release.json (git-ignored)
//
// The version is package.json's. The commit is known on a release tag's build only: the public
// repo's pages.yml, called by release.yml on the tag `vX.Y.Z` (GITHUB_REF_TYPE `tag`, GITHUB_SHA
// the release commit, which release.yml also builds into the CLI). Any other build (a branch, a
// pull request, a laptop) prints init's other form: the tag, and a comment saying to pin it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Release {
  readonly version: string;
  /** The release commit's full SHA, on a release tag's build only. */
  readonly sha?: string;
}

/** The release a build is for, from GitHub's environment and package.json's version. */
export function releaseOf(env: Readonly<Record<string, string | undefined>>, version: string): Release {
  if (env.GITHUB_REF_TYPE !== 'tag') return { version };
  const tag = env.GITHUB_REF_NAME ?? '';
  if (tag !== `v${version}`) {
    throw new Error(`the tag ${tag} is not package.json's version, v${version}`);
  }
  const sha = env.GITHUB_SHA ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GITHUB_SHA is not a full commit SHA: ${sha}`);
  return { version, sha };
}

/**
 * The sealup step of a workflow, at the left margin: init's `uses:` line (pinned to the release
 * commit; else the tag, with init's comment saying to pin it), its id, and the password from a
 * secret through `env:`.
 */
export function actionStep(release: Release): string {
  const uses =
    release.sha === undefined
      ? [
          `# Pin this step to v${release.version}'s full commit SHA (on its release page), as the`,
          '# steps above are: a tag can move, a commit cannot.',
          `- uses: sealup/sealup@v${release.version}`,
        ]
      : [`- uses: sealup/sealup@${release.sha} # v${release.version}`];
  return [...uses, '  id: sealup', '  env:', `    SEALUP_PASSWORD: $\{{ secrets.SEALUP_PASSWORD }}`].join(
    '\n',
  );
}

/** The commands that check a release came from sealup's repo, as its release notes give them. */
export function verifyCommands(version: string): string {
  const tag = `v${version}`;
  const tarball = `sealup-${version}.tgz`;
  return [
    'npm audit signatures                                     # in a project that installed sealup',
    `gh release verify ${tag} --repo sealup/sealup`,
    `gh release verify-asset ${tag} ${tarball} --repo sealup/sealup`,
    `gh attestation verify ${tarball} --repo sealup/sealup`,
    'gh attestation verify action.mjs --repo sealup/sealup',
    'sha256sum -c SHA256SUMS                                  # beside the downloaded assets',
  ].join('\n');
}

if (import.meta.main) {
  const site = join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(site, '..', 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string') throw new Error("package.json's version is missing");
  const release = releaseOf(process.env, pkg.version);
  const out = join(site, 'src', 'generated');
  mkdirSync(out, { recursive: true });
  const facts = {
    version: release.version,
    pinned: release.sha !== undefined,
    step: actionStep(release),
    verify: verifyCommands(release.version),
  };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(facts, null, 2)}\n`);
}
