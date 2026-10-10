// Golden S18, "Wrong password" (CLI page, docs/exploration/assets/06/scenarios-problems.js;
// notes goldens.md). `sealup deploy production`, exit 3. Over real SFTP: the in-process server
// refuses the login. The message names the variable and the config place, never the value (R6),
// and sealup tries the password once (hosts block an IP after failures).
//
// Page form:
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   ✗ Login refused by ssh.example.com for user deploy.
//     Check the password in PROD_PASSWORD (targets.production.password).
//     sealup never retries a refused login: hosts block an IP after failures.
//
//     Nothing was changed on production.
//     More: sealup.dev/e/login-refused

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canaries,
  createSftpServer,
  goldenText,
  type SftpServer,
} from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  hostKeyLine,
  inGitHub,
  markdown,
  productionConfig,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';
import { expectFrozenJson } from '../../freeze-kit.ts';
import { dialing } from '../../sftp-kit.ts';

let server: SftpServer;
beforeAll(async () => {
  server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
  server.faults.refuseLogin();
});
afterAll(() => server.stop());

/** The page's lines, with the in-process server's key. */
const s18 = (fingerprint: string): string[] => [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  `  host key    ${fingerprint}  {g}verified{/}`,
  '',
  '  {rb}✗{/} {b}Login refused by ssh.example.com for user deploy.{/}',
  '    Check the password in PROD_PASSWORD (targets.production.password).',
  '    sealup never retries a refused login: hosts block an IP after failures.',
  '',
  '    Nothing was changed on production.',
  '    {d}More: sealup.dev/e/login-refused{/}',
];

/** One refused login: what each run must have tried, whatever ran before it. */
const once = [{ method: 'password', accepted: false }];

describe('S18: login refused', () => {
  /** A deploy run, and the login attempts the server saw during it (not before). */
  const deploy = async (tty: boolean, flags: string[] = [], more = {}) => {
    const config = productionConfig().replace(hostKeyLine, server.hostKeyLine);
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    // The password the server is sent is a canary: the leak check in runMain looks for it.
    const env = { PROD_PASSWORD: canaries.SEALUP_CANARY_PASSWORD, ...more };
    const before = server.logins().length;
    const run = await runMain(['deploy', 'production', ...flags], {
      cwd: project.root,
      tty,
      env,
      connect: dialing(server),
    });
    return { ...run, logins: server.logins().slice(before) };
  };

  it('prints the page lines in colour on a terminal and exits 3', async () => {
    const run = await deploy(true);
    expect(run.stderr).toBe(goldenText(s18(server.fingerprint), { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(3);
    expect(run.logins).toEqual(once);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', async () => {
    const run = await deploy(false);
    const s18log = ['sealup 0.0.0-source · deploy production', ...s18(server.fingerprint)];
    expect(run.stderr).toBe(goldenText(s18log, { color: false }));
    expect(run.exitCode).toBe(3);
    expect(run.logins).toEqual(once);
  });

  it('prints one JSON object on stdout with --json: the run failed, exit 3', async () => {
    const run = await deploy(false, ['--json']);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'failed', exitCode: 3 });
    expectFrozenJson('a failure', run.stdout, 'json-failed.golden');
    const s18log = ['sealup 0.0.0-source · deploy production', ...s18(server.fingerprint)];
    expect(run.stderr).toBe(goldenText(s18log, { color: false }));
    expect(run.exitCode).toBe(3);
    expect(run.logins).toEqual(once);
  });

  // The GitHub form (page S18 `ci`): the masks, the version line, the same words, then the
  // annotation; no file: the password itself is wrong, not a line of sealup.yml.
  it('prints the GitHub form: masks, the same words, one annotation', async () => {
    const run = await deploy(false, [], inGitHub);
    const s18github = [
      ...canaryMasks,
      'sealup 0.0.0-source · deploy production',
      ...s18(server.fingerprint),
      '::error title=Login refused::Login refused by ssh.example.com for user deploy. Check the password in PROD_PASSWORD (targets.production.password). Not retried: hosts block an IP after a few failures.',
    ];
    expect(run.stderr).toBe(goldenText(s18github, { color: true }));
    expect(run.exitCode).toBe(3);
    expect(run.logins).toEqual(once);
  });

  // The job summary (page S18 `summary`; spec #24 decision 32): the secret to check, then the
  // target table, the key verified (with the in-process server's key).
  it('writes the job summary: the secret to check, the key verified', async () => {
    const run = await deploy(false, [], inGitHub);
    expect(run.summary).toBe(
      markdown([
        '### ❌ Login refused: nothing was changed on production',
        '',
        '> [!CAUTION]',
        '> `ssh.example.com` refused the login for user `deploy`. sealup does not retry a refused login: hosts block an IP after a few failures.',
        '>',
        '> **Fix:** check the secret `PROD_PASSWORD` (used by `targets.production.password`), then re-run this job.',
        '',
        '| Target | `sftp://deploy@ssh.example.com:22/home/site` |',
        '|---|---|',
        `| Host key | ED25519 \`${server.fingerprint}\` verified |`,
        '| Site | https://example.com |',
        '',
        summaryFooter('login-refused'),
      ]),
    );
    expect(run.logins).toEqual(once);
  });
});
