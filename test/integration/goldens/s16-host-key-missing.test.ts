// Golden S16, "Host key missing" (CLI page, docs/exploration/assets/06/scenarios-problems.js;
// notes goldens.md). `sealup deploy production`, exit 4. The target has no hostKey: sealup stops
// before connecting, so the password never goes to a server it cannot identify (R7).
//
// Page form:
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    missing  no hostKey for production in sealup.yml
//
//   ✗ sealup cannot confirm this server is yours: there is no host key.
//     It checks the server first, so an impostor never receives the password.
//     Run on your machine:  sealup keyscan production
//     It shows the key for you to confirm and writes hostKey into sealup.yml.
//     Commit that line.
//
//     sealup did not connect. Nothing was changed on production.
//     More: sealup.dev/e/host-key-missing

import { describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  inGitHub,
  markdown,
  productionConfig,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';

const s16 = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    {r}missing{/}  no hostKey for production in sealup.yml',
  '',
  '  {rb}✗{/} {b}sealup cannot confirm this server is yours: there is no host key.{/}',
  '    It checks the server first, so an impostor never receives the password.',
  '    Run on your machine:  sealup keyscan production',
  '    It shows the key for you to confirm and writes hostKey into sealup.yml.',
  '    Commit that line.',
  '',
  '    sealup did not connect. Nothing was changed on production.',
  '    {d}More: sealup.dev/e/host-key-missing{/}',
];

// The GitHub form (page S16 `ci`): the masks, the version line, the CI words (keyscan never
// writes a key in CI, so the fix is on your machine), then the annotation. It points at the
// target's server: line (4 here), where keyscan adds hostKey (spec #24 decision 18); the page's
// line 14 is the target's own key, which a Target does not carry.
const s16github = [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  ...s16.slice(0, 4),
  '    It checks the server first, so an impostor never receives the password.',
  "    sealup never trusts a new key in CI: it could be anyone's.",
  '    On your machine:  sealup keyscan production   then commit sealup.yml.',
  ...s16.slice(-3),
  '::error file=sealup.yml,line=4,title=Host key missing::targets.production has no hostKey, so sealup cannot confirm the server is yours. Run sealup keyscan production on your machine and commit sealup.yml. sealup never trusts a new key in CI.',
];

describe('S16: host key missing', () => {
  const project = () =>
    createProject(productionConfig({ password: 'SEALUP_CANARY_PASSWORD', hostKey: false }), {
      'public_html/index.html': '<h1>home</h1>',
    });

  it('prints the page lines in colour on a terminal and exits 4, without connecting', async () => {
    let connected = false;
    const run = await runMain(['deploy', 'production'], {
      cwd: project().root,
      tty: true,
      connect: async () => {
        connected = true;
        throw new Error('S16 must not connect');
      },
    });
    expect(run.stderr).toBe(goldenText(s16, { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(4);
    expect(connected).toBe(false);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', async () => {
    const run = await runMain(['deploy', 'production'], { cwd: project().root });
    const s16log = ['sealup 0.0.0-source · deploy production', ...s16];
    expect(run.stderr).toBe(goldenText(s16log, { color: false }));
    expect(run.exitCode).toBe(4);
  });

  it('prints the GitHub form: masks, the CI words, one annotation', async () => {
    const run = await runMain(['deploy', 'production'], { cwd: project().root, env: inGitHub });
    expect(run.stderr).toBe(goldenText(s16github, { color: true }));
    expect(run.exitCode).toBe(4);
  });

  // The job summary (page S16 `summary`; spec #24 decision 32): the caution box, then the
  // target table with the missing key.
  it('writes the job summary: the fix first, then the target and its missing key', async () => {
    const run = await runMain(['deploy', 'production'], { cwd: project().root, env: inGitHub });
    expect(run.summary).toBe(
      markdown([
        '### ❌ Host key missing: nothing was changed on production',
        '',
        '> [!CAUTION]',
        '> `targets.production` has no `hostKey`, so sealup cannot confirm the server is yours. It checks the server first, so an impostor never receives the password. sealup never trusts a new key in CI.',
        '>',
        '> **Fix:** on your machine, run `sealup keyscan production`, confirm the key, and commit `sealup.yml`.',
        '',
        '| Target | `sftp://deploy@ssh.example.com:22/home/site` |',
        '|---|---|',
        '| Host key | **missing** (no `hostKey` in sealup.yml) |',
        '| Site | https://example.com |',
        '',
        summaryFooter('host-key-missing'),
      ]),
    );
  });
});
