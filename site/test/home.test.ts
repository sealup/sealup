// The home page (ticket #67, decision 0037): round 4's layout with the CLI's own words. Its
// terminal, dry-run and job-summary samples are lines of goldens, its commands are ones `help`
// offers, so the home can't drift from the CLI any more than a guide can.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sampleProblems } from '../scripts/guide-checks.ts';
import { cells, columns, inline, plain, segments } from '../src/home/lines.ts';
import { config, home } from '../src/home/samples.ts';

describe("the home page's sealup.yml and runs", () => {
  // One test holds the file and every run: S13 would stop a dry run's "To apply" line that names
  // a target the file does not have, and mapped paths need a mapping.
  it('come from one test, which runs that very file', () => {
    const tests = Object.values(home.samples).map((sample) => sample.tests);
    assert.deepEqual([...new Set(tests.flat())], ['integration/home-page.test.ts']);
    assert.deepEqual(home.samples.config.lines, config);
  });

  it('name the target as the file does: the shorthand form names it after its host', () => {
    const host = /^server: \w+:\/\/[^@]+@([^/:]+)/.exec(config[0] ?? '')?.[1];
    assert.equal(host, 'ssh.example.com');
    const said = [...home.samples.redeploy.lines, ...home.samples.dryRun.lines, ...home.samples.summary.lines]
      .map(plain)
      .filter((line) => / to \S+ in |change on |To apply: /.test(line));
    assert.equal(said.length, 4);
    for (const line of said) assert.match(line, new RegExp(`(to|on|deploy) ${host}\\b`));
  });
});

describe('a golden line, as the page draws it', () => {
  it('turns colour tokens into styled segments', () => {
    assert.deepEqual(segments('  {gb}✓ Sealed up and delivered:{/} 14 files.'), [
      { text: '  ' },
      { text: '✓ Sealed up and delivered:', style: 'gb' },
      { text: ' 14 files.' },
    ]);
    assert.deepEqual(segments(' {inv} DRY RUN {/} nothing'), [
      { text: ' ' },
      { text: ' DRY RUN ', style: 'inv' },
      { text: ' nothing' },
    ]);
  });

  it('reads as plain text for screen readers and print, colour tokens dropped', () => {
    assert.equal(plain('  {gb}✓ Sealed up:{/} 14 files.'), '  ✓ Sealed up: 14 files.');
    assert.equal(plain(' {inv} DRY RUN {/} nothing'), '  DRY RUN  nothing');
  });

  it('marks a fingerprint, which a phone shortens', () => {
    assert.deepEqual(segments('  host key    SHA256:8H38JEn+/x=  {g}verified{/}'), [
      { text: '  host key    ' },
      { text: 'SHA256:8H38JEn+/x=', short: true },
      { text: '  ' },
      { text: 'verified', style: 'g' },
    ]);
  });

  it('splits off the size a line ends with at column 72, so a phone keeps it at the right', () => {
    assert.deepEqual(columns('  {b}Would upload 4 files{/}                       424 KB'), {
      left: '  {b}Would upload 4 files{/}',
      right: '424 KB',
    });
    assert.deepEqual(columns('  14 to upload · 30 unchanged         2.1 MB'), {
      left: '  14 to upload · 30 unchanged',
      right: '2.1 MB',
    });
    assert.equal(columns('  {b}Would delete 2 files{/}  {d}(sealup uploaded them){/}'), undefined);
    assert.equal(columns('  1,001 unchanged'), undefined);
  });
});

describe('a job summary line, as the page draws it', () => {
  it('splits a table row into its cells, an empty one included', () => {
    assert.deepEqual(cells('| Deleted | 9 | |'), ['Deleted', '9', '']);
    assert.deepEqual(cells('| | Files | Size |'), ['', 'Files', 'Size']);
  });

  it('finds the code spans of a cell', () => {
    assert.deepEqual(inline('ED25519 `SHA256:8H38` verified'), [
      { text: 'ED25519 ', code: false },
      { text: 'SHA256:8H38', code: true },
      { text: ' verified', code: false },
    ]);
    assert.deepEqual(inline('https://example.com'), [{ text: 'https://example.com', code: false }]);
  });
});

describe("the home page's samples", () => {
  it('are lines of the tests they name, and its commands are ones help offers', () => {
    assert.deepEqual(sampleProblems(home), []);
  });
});

// A golden as the tests write it: colour tokens, a value built in code, a helper's lines.
const tests: Readonly<Record<string, string>> = {
  'integration/goldens/s08-redeploy.test.ts': [
    'const s08 = [',
    "  '  14 to upload · 9 to delete · 30 unchanged                       2.1 MB',",
    "  '  {gb}✓ Sealed up and delivered:{/} 14 files to production in 3.1 s.',",
    "  '| Uploaded | 14 | 2.1 MB |',",
    '];',
  ].join('\n'),
  'deploy-kit.ts': "const target = [`| Host key | ED25519 \\`${fingerprint}\\` verified |`];",
};
const readTest = (path: string): string | undefined => tests[path];

describe('sample checks, proven to bite', () => {
  it('pass lines a test expects, colour tokens and built values aside, from several tests', () => {
    const samples = {
      commands: ['npx sealup init', 'sealup deploy --dry-run'],
      samples: {
        run: {
          tests: ['s08-redeploy'],
          lines: [
            '  14 to upload · 9 to delete · 30 unchanged                       2.1 MB',
            '',
            '  {gb}✓ Sealed up and delivered:{/} 14 files to production in 3.1 s.',
          ],
        },
        summary: {
          tests: ['s08-redeploy', 'deploy-kit.ts'],
          lines: ['| Uploaded | 14 | 2.1 MB |', '| Host key | ED25519 `SHA256:8H38` verified |'],
        },
      },
    };
    assert.deepEqual(sampleProblems(samples, { readTest }), []);
  });

  it('name a typed-in line, a missing test, a command help does not offer and other commands', () => {
    const samples = {
      commands: ['sealup deploy --force', 'rsync -a dist/ host:'],
      samples: {
        run: { tests: ['s08-redeploy'], lines: ['  14 to upload · 9 to delete · 5,839 unchanged'] },
        gone: { tests: ['s99-nothing'], lines: ['  ✓ Done.'] },
      },
    };
    assert.deepEqual(sampleProblems(samples, { readTest }), [
      'command `sealup deploy --force`: deploy has no flag --force (sealup help deploy)',
      'command `rsync -a dist/ host:`: not a sealup command',
      'run: not a line of s08-redeploy: "  14 to upload · 9 to delete · 5,839 unchanged"',
      'gone: no test s99-nothing (test/integration/goldens/s99-nothing.test.ts)',
      'gone: not a line of s99-nothing: "  ✓ Done."',
    ]);
  });
});
