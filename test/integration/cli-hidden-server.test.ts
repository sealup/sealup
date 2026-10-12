// A public repository's server (decision 0045): `server: ${SEALUP_CANARY_SERVER}` and
// `hostKey: ${SEALUP_CANARY_HOST_KEY}` in a hand-written sealup.yml. In GitHub's form the run
// masks the server, its user and host, the key line and its fingerprint before any other byte,
// and the job summary names the variables instead; a terminal and a plain log are unchanged.
// runMain's leak check reads every GitHub-form log through its masks and every summary as it is
// (testkit's expectHiddenMasked), so each run here also proves that nothing shows unmasked.

import { describe, expect, it } from 'vitest';
import {
  createMemoryServer,
  createSftpServer,
  githubLog,
  githubMasks,
  hiddenCanaries,
  screenOf,
  splitMasks,
} from '../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  markdown,
  productionConfig,
  ref,
  runMain,
  summaryTarget,
} from '../deploy-kit.ts';
import { dialing } from '../sftp-kit.ts';

const server = hiddenCanaries.SEALUP_CANARY_SERVER;
const user = 'cn4ry-user';
const host = 'cn4ry-host.example.com';
const keyLine = hiddenCanaries.SEALUP_CANARY_HOST_KEY;
const site = { 'public_html/index.html': '<h1>home</h1>' };
const env = { PROD_PASSWORD: 'pw-for-tests' };

/** The page's production target, its server and host key read from the hidden canaries. */
function hiddenConfig(): string {
  return [
    'upload: public_html',
    'targets:',
    '  production:',
    `    server: ${ref('SEALUP_CANARY_SERVER')}`,
    `    password: ${ref('PROD_PASSWORD')}`,
    `    hostKey: ${ref('SEALUP_CANARY_HOST_KEY')}`,
    '    url: https://example.com',
    '',
  ].join('\n');
}

function deploy(runEnv: Record<string, string>, options: { tty?: boolean; refuse?: boolean } = {}) {
  const project = createProject(hiddenConfig(), site);
  const memory = createMemoryServer({ loginFolder: '/home/deploy', hostKeyLine: keyLine });
  if (options.refuse === true) memory.faults.refuseLogin();
  return runMain(['deploy', '--no-color'], {
    cwd: project.root,
    env: { ...env, ...runEnv },
    tty: options.tty ?? false,
    server: memory,
  });
}

const fingerprint = createMemoryServer({ hostKeyLine: keyLine }).fingerprint;

describe('a server and host key read from variables, GitHub form', () => {
  it('masks the server, its user and host, the key line and its fingerprint first', async () => {
    const run = await deploy(inGitHub);
    const { masks, rest } = splitMasks(run.stderr);
    const masked = masks.split('\n').map((line) => line.replace('::add-mask::', ''));
    for (const value of [server, user, host, keyLine, fingerprint]) {
      expect(masked).toContain(value);
    }
    expect(rest.split('\n')[0]).toBe('sealup 0.0.0-source · deploy');
    expect(rest).not.toContain('::add-mask::');
    expect(run.exitCode).toBe(0);
  });

  it('shows the target line as GitHub masks it', async () => {
    const run = await deploy(inGitHub);
    const shown = githubMasks(run.stderr)(splitMasks(run.stderr).rest);
    expect(shown).toContain('  production  sftp://***@***:22/home/site\n');
    expect(shown).toContain('  host key    ***  verified\n');
  });

  it('names the variables in the job summary, never the server or the fingerprint', async () => {
    const run = await deploy(inGitHub);
    expect(run.summary).toContain(
      [
        `| Target | \`${ref('SEALUP_CANARY_SERVER')}\` |`,
        '|---|---|',
        `| Host key | ED25519 \`${ref('SEALUP_CANARY_HOST_KEY')}\` verified |`,
        '| Site | https://example.com |',
      ].join('\n'),
    );
  });

  // The error names the host and the user (S18): the masks registered first cover it.
  it('covers an error that names the host with the same masks', async () => {
    const run = await deploy(inGitHub, { refuse: true });
    expect(run.exitCode).toBe(3);
    const { rest } = splitMasks(run.stderr);
    expect(rest).toContain(`  ✗ Login refused by ${host} for user ${user}.\n`);
    expect(githubMasks(run.stderr)(rest)).toContain('  ✗ Login refused by *** for user ***.\n');
    expect(run.summary).toContain('`***` refused the login for user `***`.');
  });

  // S17 over real SFTP: the server shows its own key, not the one the variable holds. That key
  // gives the server away too: runMain checks, line by line, that no line shows it unmasked.
  it('names the variable for the expected key, and masks the received one', async () => {
    const sftp = await createSftpServer({ password: 'pw-for-tests' });
    try {
      const project = createProject(hiddenConfig(), site);
      const run = await runMain(['deploy', '--no-color', '--json'], {
        cwd: project.root,
        env: { ...env, ...inGitHub },
        connect: dialing(sftp),
        hidden: { 'the received key (fingerprint)': sftp.fingerprint },
      });
      expect(run.exitCode).toBe(4);
      const { rest } = splitMasks(run.stderr);
      expect(rest).toContain(`::add-mask::${sftp.fingerprint}\n`);
      const shown = githubLog(run.stderr);
      expect(shown).toContain('  production  sftp://***@***:22/home/site\n');
      expect(shown).toContain('  host key    ***  changed\n');
      expect(shown).toContain(`  sealup.yml (line 6) expects one key; *** sent another:\n`);
      expect(shown).toContain('    received  ED25519 ***\n');
      // The key is in a variable: the advice names it, never "commit sealup.yml" (0045 point 7).
      expect(shown).toContain(
        [
          "    Ask your host for the server's fingerprint. If it is the received one,",
          '    set SEALUP_CANARY_HOST_KEY to the new key in sealup.env and in CI;',
          '    on your machine,  sealup keyscan production   prints it.',
          '',
        ].join('\n'),
      );
      expect(shown).toContain(
        '::error file=sealup.yml,line=6,title=Host key changed::*** sent ***; sealup.yml expects ***. The host moved the site, or someone is intercepting. Ask your host, then set SEALUP_CANARY_HOST_KEY to the new key in sealup.env and in CI (sealup keyscan production prints it). The password was not sent.\n',
      );
      expect(run.summary).toContain(
        "> **Fix:** ask your host for the server's fingerprint. If it is the received one, set `SEALUP_CANARY_HOST_KEY` to the new key in `sealup.env` and in CI: on your machine, `sealup keyscan production` prints it ([more](https://sealup.dev/e/key-in-variable)).\n",
      );
      expect(run.stderr).not.toContain('commit sealup.yml');
      expect(run.summary).toContain(
        [
          `| Host key expected | ED25519 \`${ref('SEALUP_CANARY_HOST_KEY')}\` |`,
          '| Host key received | ED25519 `***` **changed** |',
        ].join('\n'),
      );
      expect(run.summary).toContain('> `***` sent a host key that is not the one in');
    } finally {
      await sftp.stop();
    }
  });

  // GitHub masks a user named like a common word everywhere in the log (0045's consequences);
  // the summary hides it where it shows the target only, never in sealup's own words.
  it('keeps sealup’s words whole in the summary for a user named deploy', async () => {
    const project = createProject(hiddenConfig(), site);
    const run = await runMain(['deploy', '--dry-run'], {
      cwd: project.root,
      env: {
        ...env,
        ...inGitHub,
        SEALUP_CANARY_SERVER: `sftp://deploy@${host}/home/site`,
      },
      server: createMemoryServer({ loginFolder: '/home/deploy', hostKeyLine: keyLine }),
    });
    expect(run.exitCode).toBe(0);
    expect(run.summary).toContain(`| Target | \`${ref('SEALUP_CANARY_SERVER')}\` |`);
    expect(run.summary).toContain('To apply: run `sealup deploy production`');
    expect(run.summary).not.toContain(host);
  });

  it('masks the host in the summary where a shorthand target is named after it', async () => {
    const shorthand = [
      `server: ${ref('SEALUP_CANARY_SERVER')}`,
      `password: ${ref('PROD_PASSWORD')}`,
      `hostKey: ${ref('SEALUP_CANARY_HOST_KEY')}`,
      'upload: public_html',
      '',
    ].join('\n');
    const project = createProject(shorthand, site);
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      server: createMemoryServer({ loginFolder: '/home/deploy', hostKeyLine: keyLine }),
    });
    expect(run.exitCode).toBe(0);
    expect(run.summary.split('\n')[0]).toBe(
      '### ✅ Sealed up and delivered: 1 file to *** in 0.0 s',
    );
  });

  it('masks them for `sealup` alone too, which shows the host of a target without url', async () => {
    const project = createProject(
      hiddenConfig().replace('    url: https://example.com\n', ''),
      site,
    );
    const run = await runMain([], { cwd: project.root, env: { ...env, ...inGitHub } });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(host);
    expect(splitMasks(run.stderr).masks).toContain(`::add-mask::${host}`);
  });
});

describe('keyscan of a server and host key read from variables, GitHub form', () => {
  // The server shows the page's key, not the one the variable holds: the key it shows is printed.
  it('masks the key the server shows too, with the rest, before any other byte', async () => {
    const project = createProject(hiddenConfig(), site);
    const scanned = createMemoryServer();
    const run = await runMain(['keyscan', 'production', '--no-color'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      scan: scanned.scanHostKey,
    });
    expect(run.exitCode).toBe(4);
    const { masks, rest } = splitMasks(run.stderr);
    for (const value of [host, user, keyLine, scanned.hostKeyLine, scanned.fingerprint]) {
      expect(masks.split('\n')).toContain(`::add-mask::${value}`);
    }
    expect(rest.split('\n')[0]).toBe('sealup 0.0.0-source · keyscan production');
    expect(rest).toContain(scanned.fingerprint);
    const shown = githubMasks(run.stderr)(rest);
    expect(shown).not.toContain(scanned.fingerprint);
    expect(shown).not.toContain(scanned.hostKeyLine);
    expect(shown).toContain('  production  sftp://***@***:22/home/site\n');
  });

  // The key identifies the server (0045): any hidden part of the target counts, not only a key.
  it('masks the key the server shows when only the server is hidden (no saved key)', async () => {
    const project = createProject(hiddenConfig().replace(/ {4}hostKey: .*\n/, ''), site);
    const scanned = createMemoryServer();
    const run = await runMain(['keyscan', 'production', '--no-color'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      scan: scanned.scanHostKey,
    });
    expect(run.exitCode).toBe(0);
    const { masks, rest } = splitMasks(run.stderr);
    for (const value of [scanned.hostKeyLine, scanned.fingerprint]) {
      expect(masks.split('\n')).toContain(`::add-mask::${value}`);
    }
    expect(rest).toContain(scanned.hostKeyLine);
    const shown = githubMasks(run.stderr)(rest);
    expect(shown).not.toContain(scanned.fingerprint);
    expect(shown).not.toContain(scanned.hostKeyLine);
  });

  it('masks the server when it stops before scanning (a target not in the file)', async () => {
    const project = createProject(hiddenConfig(), site);
    const run = await runMain(['keyscan', 'nope'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
    });
    expect(run.exitCode).toBe(2);
    expect(splitMasks(run.stderr).masks.split('\n')).toContain(`::add-mask::${host}`);
  });

  it('keeps the order of a plain-text target: the log starts before the scan', async () => {
    const project = createProject(productionConfig(), site);
    const scanned = createMemoryServer();
    const run = await runMain(['keyscan', 'production'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      scan: scanned.scanHostKey,
    });
    expect(run.exitCode).toBe(0);
    expect(splitMasks(run.stderr).masks).not.toContain(scanned.fingerprint);
  });
});

describe('a server and host key read from variables, on a terminal and in a plain log', () => {
  it('shows the target line whole on a terminal (R22), with no mask', async () => {
    const run = await deploy({}, { tty: true });
    const screen = screenOf(run.stderr);
    expect(screen).toContain(`  production  sftp://${user}@${host}:22/home/site\n`);
    expect(screen).toContain(`  host key    ${fingerprint}  verified\n`);
    expect(run.stderr).not.toContain('::add-mask::');
    expect(run.summary).toBe('');
  });

  it('shows the target line whole in a plain log', async () => {
    const run = await deploy({});
    expect(run.stderr.split('\n').slice(0, 2)).toEqual([
      'sealup 0.0.0-source · deploy',
      `  production  sftp://${user}@${host}:22/home/site`,
    ]);
  });
});

describe('a server in plain text, GitHub form', () => {
  it('is not masked, and the summary shows it (nothing changes without a reference)', async () => {
    const project = createProject(productionConfig(), site);
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      server: createMemoryServer({ loginFolder: '/home/deploy' }),
    });
    expect(splitMasks(run.stderr).masks).toBe(
      ['pw-for-tests', 'cHctZm9yLXRlc3Rz', '70772d666f722d7465737473', '70772D666F722D7465737473']
        .map((value) => `::add-mask::${value}`)
        .join('\n'),
    );
    expect(run.summary).toContain(markdown(summaryTarget).trimEnd());
  });
});
