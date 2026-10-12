// The guide checks (spec #41 story 93, ticket #65), proven to bite: every `sealup` command on a
// page matches what `help` offers, and every block of sealup's output comes from a test of the
// CLI (a golden), never typed by hand.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { expectedLines, pageProblems } from '../scripts/guide-checks.ts';

const testFolder = join(import.meta.dirname, '..', '..', 'test');
const docs = join(import.meta.dirname, '..', 'src', 'content', 'docs');

describe("the site's pages", () => {
  // The config page is generated from schema.json at each build (git-ignored): not checked here.
  const pages = readdirSync(docs, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
    .map((entry) => relative(docs, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((page) => page !== 'config.md')
    .sort();

  it('pass: commands as help gives them, output from the tests', () => {
    const problems = pages.flatMap((page) =>
      pageProblems(page, readFileSync(join(docs, ...page.split('/')), 'utf8')),
    );
    assert.deepEqual(problems, []);
  });
});

/** A page's Markdown from its lines. */
const md = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('sealup commands on a page, proven to bite', () => {
  it('passes commands that help offers, with their flags and a target', () => {
    const page = md(
      '```sh',
      'sealup init --server sftp://deploy@ssh.example.com/home/site/www',
      'sealup deploy --dry-run          # see what would change',
      'npx sealup@0.1.0 deploy production --mirror --check-server',
      'sealup keyscan staging -c site/sealup.yml',
      'sealup check --json',
      'sealup help config',
      'sealup --version',
      'sealup deploy [target] [flags]',
      'sealup help <command>',
      '```',
    );
    assert.deepEqual(pageProblems('guide.md', page), []);
  });

  it('names an unknown command, an unknown flag and a flag of another command', () => {
    const page = md(
      'Run `sealup deploy --force` first.',
      '',
      '```sh',
      'sealup publish',
      'sealup pull --mirror',
      'sealup init production',
      'sealup deploy -n',
      '```',
    );
    assert.deepEqual(pageProblems('guide.md', page), [
      'guide.md:1 `sealup deploy --force`: deploy has no flag --force (sealup help deploy)',
      'guide.md:4 `sealup publish`: no command publish (sealup help)',
      'guide.md:5 `sealup pull --mirror`: pull has no flag --mirror (sealup help pull)',
      'guide.md:6 `sealup init production`: init takes no target (sealup help init)',
      'guide.md:7 `sealup deploy -n`: deploy has no flag -n (sealup help deploy)',
    ]);
  });
});

// A test file as the goldens write them: lines in quotes, colour tokens, values built in code,
// and comments (the mockup's page form) that are not what sealup prints.
const golden = [
  "// Page form (5,862 files / 41.0 MB): '  ✓ Sealed up and delivered: 5,862 files to production in 15.6 s.'",
  "const server = 'sftp://deploy@ssh.example.com/home/site/www';",
  "const apostrophe = /it's/g; // a regex, not a string",
  'const s07 = [',
  "  '  production  sftp://deploy@ssh.example.com:22/home/site',",
  "  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',",
  "  '',",
  "  '  {gb}✓ Sealed up and delivered:{/} 1,200 files to production in 15.6 s.',",
  '  `  Server address: ${server}`,',
  "  \"  It's done.\",",
  "  `  Password for deploy@ssh.example.com: ${'•'.repeat(password.length)}`,",
  '];',
].join('\n');

const tests: Readonly<Record<string, string>> = {
  'integration/goldens/s07-first-deploy.test.ts': golden,
  'integration/cli-ssh.test.ts': "const lines = ['  transfer    file by file over SFTP (no tar on the server)'];",
};
const readTest = (path: string): string | undefined => tests[path];

describe("sealup's output on a page, proven to bite", () => {
  it('passes a text block whose every line a golden expects, colours and built values aside', () => {
    const page = md(
      '<!-- output: s07-first-deploy -->',
      '```text',
      '$ sealup deploy',
      '  production  sftp://deploy@ssh.example.com:22/home/site',
      '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified',
      '',
      '  ✓ Sealed up and delivered: 1,200 files to production in 15.6 s.',
      '  Server address: sftp://deploy@ssh.example.com/~',
      "  It's done.",
      '  Password for deploy@ssh.example.com: ••••••••',
      '```',
      '',
      '<!-- output: integration/cli-ssh.test.ts -->',
      '```text',
      '  transfer    file by file over SFTP (no tar on the server)',
      '```',
    );
    assert.deepEqual(pageProblems('guide.md', page, { readTest }), []);
  });

  it('names a line no golden expects, a comment line, and a typed-in block', () => {
    const page = md(
      '<!-- output: s07-first-deploy -->',
      '```text',
      '  ✓ Sealed up and delivered: 1,201 files to production in 15.6 s.',
      '  ✓ Sealed up and delivered: 5,862 files to production in 15.6 s.',
      '```',
      '',
      '```text',
      '  ✓ Done.',
      '```',
      '',
      '<!-- output: s99-nothing -->',
      '```text',
      '  ✓ Done.',
      '```',
    );
    assert.deepEqual(pageProblems('guide.md', page, { readTest }), [
      'guide.md:3 not a line of s07-first-deploy: "  ✓ Sealed up and delivered: 1,201 files to production in 15.6 s."',
      'guide.md:4 not a line of s07-first-deploy: "  ✓ Sealed up and delivered: 5,862 files to production in 15.6 s."',
      'guide.md:7 a text block of sealup output needs <!-- output: <test> --> above it',
      'guide.md:11 no test s99-nothing (test/integration/goldens/s99-nothing.test.ts)',
    ]);
  });

  it("reads the real goldens: S07's lines are there, its page-form comment is not", () => {
    const source = readFileSync(join(testFolder, 'integration', 'goldens', 's07-first-deploy.test.ts'), 'utf8');
    const lines = expectedLines(source);
    const has = (text: string) => lines.some((pattern) => pattern.test(text));
    assert.ok(has('  ✓ Sealed up and delivered: 1,200 files to production in 15.6 s.'));
    assert.ok(has('  1,200 to upload                                                 1.2 MB'));
    assert.ok(!has('  ✓ Sealed up and delivered: 5,862 files to production in 15.6 s.'));
  });

  it('leaves the error pages their example blocks', () => {
    const page = md('```text', '  ✗ Something went wrong.', '```');
    assert.deepEqual(pageProblems('e/usage.md', page, { readTest }), []);
  });
});
