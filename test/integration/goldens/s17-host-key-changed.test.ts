// Golden S17, "Host key changed" (CLI page, docs/exploration/assets/06/scenarios-problems.js;
// notes goldens.md). `sealup deploy production`, exit 4. Over real SFTP: the in-process server
// shows its own key while sealup.yml pins another; sealup stops before logging in (R7). The
// fingerprints and the hostKey line come from the fixture (the page's are made up).
//
// Page form:
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:Xk3pR9vT2mWq8LzN4bYcF7hJ1dS6gA0eU5oKiE2nVtM  changed
//
//   ✗ The server's host key changed. sealup stopped before logging in.
//     sealup.yml (line 17) expects one key; ssh.example.com sent another:
//       expected  ED25519 SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM
//       received  ED25519 SHA256:Xk3pR9vT2mWq8LzN4bYcF7hJ1dS6gA0eU5oKiE2nVtM
//     Either your host moved the site to a new server, or someone between you
//     and the server is intercepting the connection.
//     Ask your host for the server's fingerprint. If it is the received one:
//       sealup keyscan production   then commit sealup.yml.
//
//     The password was not sent. Nothing was changed on production.
//     More: sealup.dev/e/host-key-changed

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
  hostKeyFingerprint,
  inGitHub,
  markdown,
  productionConfig,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';
import { dialing } from '../../sftp-kit.ts';

let server: SftpServer;
beforeAll(async () => {
  server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
});
afterAll(() => server.stop());

/** The page's lines with this fixture's keys; sealup.yml pins the key on its line 6. */
const s17 = (received: string): string[] => [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  `  host key    ${received}  {rb}changed{/}`,
  '',
  "  {rb}✗{/} {b}The server's host key changed. sealup stopped before logging in.{/}",
  '    sealup.yml (line 6) expects one key; ssh.example.com sent another:',
  `      expected  ED25519 ${hostKeyFingerprint}`,
  `      received  ED25519 ${received}`,
  '    Either your host moved the site to a new server, or someone between you',
  '    and the server is intercepting the connection.',
  "    Ask your host for the server's fingerprint. If it is the received one:",
  '      sealup keyscan production   then commit sealup.yml.',
  '',
  '    The password was not sent. Nothing was changed on production.',
  '    {d}More: sealup.dev/e/host-key-changed{/}',
];

/**
 * The GitHub form (page S17 `ci`): the masks, the version line, the CI words (keyscan runs on your
 * machine: it never writes a key in CI), then the annotation at the hostKey line.
 */
const s17github = (received: string): string[] => [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  ...s17(received).slice(0, 9),
  "    Ask your host for the server's fingerprint. If it is the received one, on",
  '    your machine:  sealup keyscan production   then commit sealup.yml.',
  ...s17(received).slice(-3),
  `::error file=sealup.yml,line=6,title=Host key changed::ssh.example.com sent ${received}; sealup.yml expects ${hostKeyFingerprint}. The host moved the site, or someone is intercepting. Ask your host, then run sealup keyscan production on your machine. The password was not sent.`,
];

describe('S17: host key changed', () => {
  const deploy = (tty: boolean, env = {}) => {
    // productionConfig pins the page's key (deploy-kit), which the server does not hold.
    const project = createProject(productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }), {
      'public_html/index.html': '<h1>home</h1>',
    });
    const connect = dialing(server);
    return runMain(['deploy', 'production'], { cwd: project.root, tty, env, connect });
  };

  it('prints the GitHub form: masks, the CI words, one annotation at the hostKey line', async () => {
    const run = await deploy(false, inGitHub);
    expect(run.stderr).toBe(goldenText(s17github(server.fingerprint), { color: true }));
    expect(run.exitCode).toBe(4);
  });

  it('prints the page lines in colour on a terminal and exits 4', async () => {
    const run = await deploy(true);
    expect(run.stderr).toBe(goldenText(s17(server.fingerprint), { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(4);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', async () => {
    const run = await deploy(false);
    const s17log = ['sealup 0.0.0-source · deploy production', ...s17(server.fingerprint)];
    expect(run.stderr).toBe(goldenText(s17log, { color: false }));
    expect(run.exitCode).toBe(4);
  });

  // The job summary (page S17 `summary`; spec #24 decision 32): the two causes and the fix, then
  // the target table with both keys side by side.
  it('writes the job summary: the fix, then the expected and received keys', async () => {
    const run = await deploy(false, inGitHub);
    expect(run.summary).toBe(
      markdown([
        '### ❌ Host key changed: nothing was changed on production',
        '',
        '> [!CAUTION]',
        '> `ssh.example.com` sent a host key that is not the one in `sealup.yml` (line 6). sealup stopped before logging in; the password was not sent.',
        '>',
        '> Either your host moved the site to a new server, or someone between the runner and the server is intercepting the connection.',
        '>',
        "> **Fix:** ask your host for the server's fingerprint. If it is the received one, run `sealup keyscan production` on your machine and commit `sealup.yml`.",
        '',
        '| Target | `sftp://deploy@ssh.example.com:22/home/site` |',
        '|---|---|',
        `| Host key expected | ED25519 \`${hostKeyFingerprint}\` |`,
        `| Host key received | ED25519 \`${server.fingerprint}\` **changed** |`,
        '| Site | https://example.com |',
        '',
        summaryFooter('host-key-changed'),
      ]),
    );
  });

  it('never sent the password, and changed nothing on the server', () => {
    expect(server.logins()).toEqual([]);
    expect(server.files().size).toBe(0);
  });
});
