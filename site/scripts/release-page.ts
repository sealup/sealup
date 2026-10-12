// The release facts the site prints, written at each build (spec sealup/sealup#41 decision 40,
// story 96, I-088): the sealup step of a workflow, by the version tag as `sealup init` writes it
// (decision 0043: immutable releases lock the tag), and the verify commands of the version built
// (as SECURITY.md and the release notes give them).
//
//   node scripts/release-page.ts    writes src/generated/release.json (git-ignored)
//
// The version is package.json's. On a release tag's build (the public repo's pages.yml, called by
// release.yml on the tag `vX.Y.Z`, GITHUB_REF_TYPE `tag`), the tag must be that version.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Release {
  readonly version: string;
}

/** The release a build is for: package.json's version, checked against the tag on a tag build. */
export function releaseOf(env: Readonly<Record<string, string | undefined>>, version: string): Release {
  if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`the tag ${env.GITHUB_REF_NAME ?? ''} is not package.json's version, v${version}`);
  }
  return { version };
}

/**
 * The sealup step of a workflow, at the left margin (spec #88 decision 12): `uses:` by the version
 * tag, then the password from a secret through `env:`. With `id`, the step has `id: sealup`, as
 * init's workflow and the Action page give it, for `steps.sealup.outputs.url`.
 */
export function actionStep(release: Release, options: { readonly id?: boolean } = {}): string {
  return [
    `- uses: sealup/sealup@v${release.version}`,
    ...(options.id === true ? ['  id: sealup'] : []),
    '  env:',
    `    SEALUP_PASSWORD: $\{{ secrets.SEALUP_PASSWORD }}`,
  ].join('\n');
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
    /** The home page's step. */
    step: actionStep(release),
    /** The Action page's step, which reads `steps.sealup.outputs.url`. */
    stepWithId: actionStep(release, { id: true }),
    verify: verifyCommands(release.version),
  };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(facts, null, 2)}\n`);
}
