// The release facts the site prints, generated at build time (spec #41 decision 40, story 96,
// I-088): the GitHub Action page's step is pinned to the release commit's full SHA, as `sealup
// init` writes it, and the verify commands name the version built, as SECURITY.md's do.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { expectedLines } from '../scripts/guide-checks.ts';
import { actionStep, releaseOf, verifyCommands } from '../scripts/release-page.ts';

const repo = join(import.meta.dirname, '..', '..');
const sha = '0123456789abcdef0123456789abcdef01234567';
const tagBuild = { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1.0', GITHUB_SHA: sha };

describe('the release a build is for', () => {
  it("is the tag's commit on a release tag's build (the public repo's pages.yml)", () => {
    assert.deepEqual(releaseOf(tagBuild, '0.1.0'), { version: '0.1.0', sha });
  });

  it('has no commit on any other build: a branch, a pull request, a laptop', () => {
    const branch = { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_SHA: sha };
    assert.deepEqual(releaseOf(branch, '0.1.0'), { version: '0.1.0' });
    assert.deepEqual(releaseOf({}, '0.1.0'), { version: '0.1.0' });
  });

  it("stops a tag build whose tag is not package.json's version, or whose SHA is not one", () => {
    assert.throws(() => releaseOf({ ...tagBuild, GITHUB_REF_NAME: 'v0.2.0' }, '0.1.0'), /v0\.2\.0/);
    assert.throws(() => releaseOf({ ...tagBuild, GITHUB_SHA: 'abc' }, '0.1.0'), /SHA/);
  });
});

describe("the GitHub Action page's step", () => {
  it('is pinned to the release commit, its tag in a comment', () => {
    assert.equal(
      actionStep({ version: '0.1.0', sha }),
      [
        `- uses: sealup/sealup@${sha} # v0.1.0`,
        '  id: sealup',
        '  env:',
        `  ${'  '}SEALUP_PASSWORD: $\{{ secrets.SEALUP_PASSWORD }}`,
      ].join('\n'),
    );
  });

  // S02 holds what `sealup init` writes, both forms: the page's step must be init's, line for line.
  const s02 = expectedLines(
    readFileSync(join(repo, 'test', 'integration', 'goldens', 's02-init.test.ts'), 'utf8'),
  );
  const asInit = (step: string): string[] =>
    step.split('\n').map((line) => `      ${line}`).filter((line) => !s02.some((p) => p.test(line)));

  it("is the step `sealup init` writes in a release build (S02's lines)", () => {
    assert.deepEqual(asInit(actionStep({ version: '0.0.0-source', sha })), []);
  });

  it('without a release commit, is init\'s tag form, with the comment saying to pin it', () => {
    const step = actionStep({ version: '0.1.0' });
    assert.match(step, /^# Pin this step to v0\.1\.0's full commit SHA/);
    assert.match(step, /^- uses: sealup\/sealup@v0\.1\.0$/m);
    assert.deepEqual(asInit(actionStep({ version: '0.0.0-source' })), []);
  });
});

describe('the GitHub Action page', () => {
  const page = readFileSync(
    join(repo, 'site', 'src', 'content', 'docs', 'github-action.mdx'),
    'utf8',
  );

  it("shows the step written at build time, not one typed in", () => {
    assert.match(page, /^import release from '\.\.\/\.\.\/generated\/release\.json';$/m);
    assert.match(page, /<Code code=\{release\.step\} lang="yaml"/);
    assert.doesNotMatch(page, /sealup\/sealup@[0-9a-f]{40}/);
  });

  it("has a row for each input and output of action.yml", () => {
    const action = readFileSync(join(repo, 'action.yml'), 'utf8');
    const keys = (section: string): string[] => {
      const body = new RegExp(`^${section}:\\n((?: .*\\n|\\n)*)`, 'm').exec(action)?.[1] ?? '';
      return [...body.matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1] ?? '');
    };
    const inputs = keys('inputs');
    const outputs = keys('outputs');
    assert.deepEqual(inputs, ['target', 'config', 'dry-run', 'working-directory']);
    assert.equal(outputs.length, 8);
    for (const key of [...inputs, ...outputs]) {
      assert.match(page, new RegExp(`^\\| \`${key}\` \\|`, 'm'), `a row for ${key}`);
    }
  });
});

describe('the security page', () => {
  const page = readFileSync(join(repo, 'site', 'src', 'content', 'docs', 'security.mdx'), 'utf8');

  it("names each known limit of SECURITY.md, in SECURITY.md's words", () => {
    const security = readFileSync(join(repo, 'SECURITY.md'), 'utf8');
    const limits = /^## Known limits\n([\s\S]*?)(?:^## |(?![\s\S]))/m.exec(security)?.[1] ?? '';
    const heads = [...limits.matchAll(/^- \*\*(.+?)\*\*/gm)].map((match) => match[1] ?? '');
    assert.ok(heads.length >= 5, 'the known limits of SECURITY.md');
    for (const head of heads) assert.ok(page.includes(`**${head}**`), head);
  });

  it('shows the verify commands written at build time', () => {
    assert.match(page, /<Code code=\{release\.verify\} lang="sh"/);
  });
});

describe('the verify commands', () => {
  it('name the version and its files, and cover the action bundle too', () => {
    const commands = verifyCommands('0.1.0');
    assert.match(commands, /^gh release verify v0\.1\.0 --repo sealup\/sealup$/m);
    assert.match(commands, /^gh attestation verify sealup-0\.1\.0\.tgz --repo sealup\/sealup$/m);
    assert.match(commands, /^gh attestation verify action\.mjs --repo sealup\/sealup$/m);
  });

  it("hold every verify command of SECURITY.md, at SECURITY.md's version", () => {
    const security = readFileSync(join(repo, 'SECURITY.md'), 'utf8');
    const block = /To verify a release \(here ([\d.]+)\):\s*```sh\n([\s\S]*?)```/.exec(security);
    assert.ok(block, "SECURITY.md's verify block");
    const [, version = '', text = ''] = block;
    const site = verifyCommands(version).split('\n');
    for (const line of text.trim().split('\n')) assert.ok(site.includes(line), line);
  });
});
