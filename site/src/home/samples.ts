// What the home page shows of sealup itself (decision 0037): the commands, as `help` offers them,
// the `sealup.yml`, and what sealup prints for that file, as lines of one test of the CLI,
// test/integration/home-page.test.ts (colour tokens included, which the page turns into colours).
// `test/home.test.ts` checks them against help and that test, so edit a sample by copying lines
// from the test, never by typing them.

import type { Samples } from '../../scripts/guide-checks.ts';

/** The commands the page shows. */
export const commands = {
  init: 'npx sealup init',
  deploy: 'sealup deploy',
  dryRun: 'sealup deploy --dry-run',
} as const;

/** The test that runs the page's sealup.yml and prints every sample below. */
const test = 'integration/home-page.test.ts';

/**
 * The page's `sealup.yml`: `sealup init`'s shorthand form plus a `url`, so its one target is
 * named after the server's host. The host key is shortened on the page, which says so.
 */
export const config = [
  'server: sftp://deploy@ssh.example.com/home/site',
  'password: ${SEALUP_PASSWORD}',
  'hostKey: ssh-ed25519 AAAAC3Nz…Lywt86',
  'upload: dist',
  'url: https://example.com',
];

/** The target's name, as sealup prints it for that file. */
export const target = 'ssh.example.com';

/**
 * The redeploy the terminal plays (terminal form). The blank line after the plan is where the
 * progress line is drawn during the transfer, then cleared, as on a real terminal.
 */
const redeploy = [
  '  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  14 to upload · 9 to delete · 30 unchanged                       2.1 MB',
  '',
  '  {gb}✓ Sealed up and delivered:{/} 14 files to ssh.example.com in 3.1 s.',
  '    {d}9 old files removed · https://example.com{/}',
];

/** Where the progress line is drawn: the blank line after the plan. */
export const progressAt = 4;

/** The progress line's totals at the end of the transfer (14 files, 2,150,400 bytes). */
export const progressTotals = { files: 14, megabytes: 2.1 } as const;

/** The dry run (terminal form). */
const dryRun = [
  ' {inv} DRY RUN {/} nothing will change on ssh.example.com',
  '  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
  '',
  '  {b}Would upload 4 files{/}                                            424 KB',
  '    {g}+{/} admin/main.1b7e9f30.js                                        3 KB',
  '    {g}+{/} main.4f2a9c1e.js                                            412 KB',
  '    ~ about.html                                                    5 KB',
  '    ~ index.html                                                    4 KB',
  '  {b}Would delete 2 files{/}  {d}(sealup uploaded them; they are no longer in your build){/}',
  '    {r}-{/} admin/main.93c5b8e0.js',
  '    {r}-{/} main.8b1e3d07.js',
  '  41 unchanged',
  '',
  ' {inv} DRY RUN {/} nothing was changed. To apply: {b}sealup deploy ssh.example.com{/}',
];

/**
 * The redeploy's job summary (GitHub form): its heading and its two tables, in Markdown as sealup
 * writes them. The timing line and the list of changes are left out.
 */
const summary = [
  '### ✅ Sealed up and delivered: 14 files to ssh.example.com in 3.1 s',
  '| Target | `sftp://deploy@ssh.example.com:22/home/site` |',
  '| Host key | ED25519 `SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM` verified |',
  '| Site | https://example.com |',
  '| | Files | Size |',
  '| Uploaded | 14 | 2.1 MB |',
  '| Deleted | 9 | |',
  '| Unchanged | 30 | 30 KB |',
];

export const home = {
  commands: Object.values(commands),
  samples: {
    config: { tests: [test], lines: config },
    redeploy: { tests: [test], lines: redeploy },
    dryRun: { tests: [test], lines: dryRun },
    summary: { tests: [test], lines: summary },
  },
} satisfies Samples;
