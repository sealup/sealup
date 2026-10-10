// Golden S04, "Save the server key" (CLI page, docs/exploration/assets/06/
// scenarios-start-daily.js; spec #24 decision 18). `sealup keyscan` in a one-target project whose
// sealup.yml has no hostKey yet: the key's fingerprint, the comparison to make, and the key saved
// only on a yes, on a terminal (exit 0). Without a terminal it only prints the line to paste and
// never writes sealup.yml (R7). The password variable is not set: keyscan never reads it.
//
// Page form (terminal):
//   server      sftp://deploy@ssh.example.com:22/home/site/www
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  not saved
//
//   This is the server's ED25519 key. Compare the fingerprint with the one in
//   your host's control panel (SSH settings), or ask their support.
//   If they match, this is your server.
//   Save it to sealup.yml as hostKey? [y/N] y
//
//   ✓ Saved. sealup.yml now holds this key (hostKey, line 3).
//     From now on sealup checks it before it sends your password. If the
//     server ever shows another key, sealup stops and changes nothing.
//
// Adapted, each on purpose:
// - The target block's label is the shorthand target's name, its host (ruling 4), as a deploy's
//   target block prints it, not the page's `server`: one target, one name, in every command.
// - The fixture has `upload: dist` first, so `server:` is line 2 and the key, added after it
//   (decision 18), lands on line 3 as on the page.
// - A plain log (not GitHub, not a terminal) may be a laptop's pipe: it says sealup saves a key
//   only after a yes on a terminal, instead of naming CI (as T27's log forms do).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMemoryServer, goldenText, screenOf } from '../../../src/testkit/index.ts';
import { createProject, hostKeyLine, inGitHub, ref, runMain } from '../../deploy-kit.ts';
import { expectFrozenJson } from '../../freeze-kit.ts';

const config = [
  'upload: dist',
  'server: sftp://deploy@ssh.example.com/home/site/www',
  `password: ${ref('SEALUP_PASSWORD')}`,
  '',
].join('\n');

const block = [
  '  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site/www',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {y}not saved{/}',
  '',
];

const s04 = [
  ...block,
  "  This is the server's ED25519 key. Compare the fingerprint with the one in",
  "  your host's control panel (SSH settings), or ask their support.",
  '  If they match, this is your server.',
  '  Save it to sealup.yml as hostKey? [y/N] y',
  '',
  '  {gb}✓ Saved.{/} sealup.yml now holds this key (hostKey, line 3).',
  '    From now on sealup checks it before it sends your password. If the',
  '    server ever shows another key, sealup stops and changes nothing.',
];

const paste = (first: string, where: string): string[] => [
  ...block,
  `  Nothing was saved: ${first}`,
  "  Compare the fingerprint with your host's control panel, then paste this",
  `  line into sealup.yml yourself (or run sealup keyscan ${where}):`,
  '',
  `  hostKey: ${hostKeyLine}`,
];

function project() {
  return createProject(config, { 'dist/index.html': '<h1>home</h1>' });
}

describe('S04: save the server key', () => {
  it('asks on a terminal, saves on a yes, and says which line holds the key', async () => {
    const { root, config: file } = project();
    const server = createMemoryServer();
    const run = await runMain(['keyscan'], {
      cwd: root,
      tty: true,
      keys: ['y', '\r'],
      scan: server.scanHostKey,
    });
    expect(screenOf(run.stderr)).toBe(goldenText(s04, { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      [
        'upload: dist',
        'server: sftp://deploy@ssh.example.com/home/site/www',
        `hostKey: ${hostKeyLine}`,
        `password: ${ref('SEALUP_PASSWORD')}`,
        '',
      ].join('\n'),
    );
    expect(server.logins()).toEqual([]);
  });

  it("prints the GitHub form: CI's words, the line to paste, and never writes", async () => {
    const { root, config: file } = project();
    const run = await runMain(['keyscan'], {
      cwd: root,
      env: inGitHub,
      scan: createMemoryServer().scanHostKey,
    });
    const s04github = [
      'sealup 0.0.0-source · keyscan',
      ...paste('sealup never trusts a server key from CI.', 'on your computer'),
    ];
    expect(run.stderr).toBe(goldenText(s04github, { color: true }));
    expect(run.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(config);
  });

  it('prints the log form without colour: the same line to paste, nothing written', async () => {
    const { root, config: file } = project();
    const run = await runMain(['keyscan'], { cwd: root, scan: createMemoryServer().scanHostKey });
    const s04log = [
      'sealup 0.0.0-source · keyscan',
      ...paste('sealup saves a key only after a yes on a terminal.', 'on a terminal'),
    ];
    expect(run.stderr).toBe(goldenText(s04log, { color: false }));
    expect(run.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(config);
  });

  it('gives --json: command keyscan, the hostKey shown and its state', async () => {
    const { root } = project();
    const run = await runMain(['keyscan', '--json'], {
      cwd: root,
      scan: createMemoryServer().scanHostKey,
    });
    expectFrozenJson('sealup keyscan (S04)', run.stdout, 'json-keyscan.golden');
    expect(run.exitCode).toBe(0);
  });
});
