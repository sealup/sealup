// Golden S03, "Convert a sam-sync project" (CLI page, docs/exploration/assets/06/
// scenarios-start-daily.js; spec #24 decision 22). `sealup init` in a project that still deploys
// with sam-sync: it offers the conversion because a .deployment.json is there, says what it
// converted, checks the server's key, writes every file, names the package.json scripts that
// still call sam-sync, and ends with the warning to delete the old files and change the
// password (exit 0). The conversion is undocumented: the page has no CI form (`ci: null`).
//
// The sam-sync files are synthetic (test/sam-sync-kit.ts): the page's "Before: sam-sync"
// (reference.js), with verbose and dry as the screen says, in sam-sync's own format.
//
// Adapted, each on purpose:
// - The two dim notes under "Converted:" are a paragraph each: the page breaks its one
//   paragraph before "used" by hand, which no wrap at 80 columns gives.
// - The target block's label is the shorthand target's name, its host (ruling 4), as in S02.
// - The warning's `!` is yellow (`{y}`), as the page's own grammar writes every warning ("A
//   yellow ! and one fix line") and as S06 and S17 print it; S03 alone has it bold (`{yb}`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { canaries, createMemoryServer, goldenText, screenOf } from '../../../src/testkit/index.ts';
import { hostKeyLine, newProject, ref, runMain } from '../../deploy-kit.ts';
import { samSyncProject } from '../../sam-sync-kit.ts';

const password = canaries.SEALUP_CANARY_PASSWORD;
const appEnv = canaries.SEALUP_CANARY_MULTILINE;

const s03 = [
  '  Found a sam-sync setup: .deployment.json and .download.json.',
  '  Convert it to sealup.yml? [Y/n] y',
  '',
  '  Converted:',
  '    server          sftp://deploy@ssh.example.com/home/site',
  '    2 folders       public_html → www, api → api',
  '    4 excludes      public_html/resources, api/.env, api/.env.prod, api/storage',
  `    1 renamed file  api/.env.prod → api/.env, now written from $\{APP_ENV}`,
  '    1 pull folder   www/resources → public_html/resources',
  '    2 secrets       SEALUP_PASSWORD (the password), APP_ENV (api/.env.prod)',
  '                    {d}both moved to sealup.env, never written in sealup.yml{/}',
  '  {d}Not needed any more: verbose and dry (use -v and -n).{/}',
  '  {d}.download.json used the same server, so it became the pull: section.{/}',
  '',
  "  sam-sync never checked the server's identity. sealup does, before each login:",
  '',
  '  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {y}not saved{/}',
  '',
  "  This is the server's ED25519 key. Compare the fingerprint with the one in",
  "  your host's control panel (SSH settings), or ask their support.",
  '  If they match, this is your server.',
  '  Save it to sealup.yml as hostKey? [y/N] y',
  '',
  '  {gb}✓ This project is set up.{/} Files written:',
  '    {g}+{/} sealup.yml                     from your 2 sam-sync files',
  '    {g}+{/} sealup.env                     SEALUP_PASSWORD, APP_ENV (git-ignored)',
  '    ~ .gitignore                     added the line sealup.env',
  '    {g}+{/} .github/workflows/deploy.yml   on push to main: build, then deploy',
  '  {d}package.json still calls sam-sync in deploy and download: change them to{/}',
  '  {d}sealup deploy and sealup pull.{/}',
  '',
  '  On GitHub, add the secrets {b}SEALUP_PASSWORD{/} and {b}APP_ENV{/}:',
  '  {d}Settings › Secrets and variables › Actions › New repository secret{/}',
  '',
  '  {y}!{/} {b}The old sam-sync files hold your password, and git history keeps it.{/}',
  '    Delete them:  git rm .deployment.json .download.json  then commit.',
  '    Then change the password on the host, in sealup.env and in SEALUP_PASSWORD.',
  '',
  '  {b}Next:{/}',
  '    sealup deploy -n    dry run: list every change, change nothing',
  '    sealup deploy       deploy to ssh.example.com',
];

describe('S03: convert a sam-sync project', () => {
  it('offers the conversion, converts both files, and says what is left to do', async () => {
    const root = newProject(samSyncProject());
    const scan = createMemoryServer();
    const run = await runMain(['init'], {
      cwd: root,
      tty: true,
      keys: ['y', '\r', 'y', '\r'],
      scan: scan.scanHostKey,
    });
    expect(screenOf(run.stderr)).toBe(goldenText(s03, { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(0);
    expect(scan.logins()).toEqual([]);

    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toBe(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        `hostKey: ${hostKeyLine}`,
        'upload:',
        '  public_html: www',
        '  api: api',
        'exclude:',
        '  - public_html/resources',
        '  - api/.env',
        '  - api/.env.prod',
        '  - api/storage',
        'write:',
        `  api/.env: ${ref('APP_ENV')}`,
        'pull:',
        '  www/resources: public_html/resources',
        '',
      ].join('\n'),
    );
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
      APP_ENV: appEnv,
    });
    const workflow = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(workflow).toContain(
      [
        '        env:',
        `          SEALUP_PASSWORD: $\{{ secrets.SEALUP_PASSWORD }}`,
        `          APP_ENV: $\{{ secrets.APP_ENV }}`,
        '',
      ].join('\n'),
    );
    // init deletes nothing and edits no script: the old files are the person's to remove.
    for (const [path, content] of Object.entries(samSyncProject())) {
      if (path === '.gitignore') continue;
      expect(readFileSync(join(root, ...path.split('/')), 'utf8')).toBe(content);
    }
  });
});
