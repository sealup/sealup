// Login with a private key as main() runs it (decision 0033, spec #41 stories 24-30): the
// in-process SFTP server and the real transport. The key is the canary key, so runMain's leak
// check covers every line of it in every output (R1); GitHub masks each line first (R2). A key
// sealup cannot read stops before connecting, exit 2, with its own words and slug; a key the
// server refuses is a refused login, exit 3, tried once (I-072).

import { afterEach, describe, expect, it } from 'vitest';
import {
  canaries,
  canaryKeyLine,
  createSftpServer,
  expectNoLeaks,
  goldenText,
  type SftpServer,
  splitMasks,
  userKey,
} from '../../src/testkit/index.ts';
import {
  createProject,
  hostKeyLine,
  inGitHub,
  productionConfig,
  ref,
  runMain,
  versionLine,
} from '../deploy-kit.ts';
import { dialing } from '../sftp-kit.ts';

const site = { 'public_html/index.html': '<h1>home</h1>' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An in-process server that accepts the canary key (or `keys`) for user deploy. */
async function sftpServer(keys: readonly string[] = [canaryKeyLine]): Promise<SftpServer> {
  const server = await createSftpServer({ authorizedKeys: keys });
  cleanups.push(() => server.stop());
  return server;
}

/**
 * The page's production target pinning `server`'s key, logging in with the key in `variable`
 * (line 5), and with `passphrase` reading KEY_PASSPHRASE (line 6) when asked.
 */
function keyProject(
  server: SftpServer,
  options: { readonly variable?: string; readonly passphrase?: boolean } = {},
) {
  const login = [
    `    privateKey: ${ref(options.variable ?? 'SEALUP_CANARY_KEY')}`,
    ...(options.passphrase === true ? [`    passphrase: ${ref('KEY_PASSPHRASE')}`] : []),
  ].join('\n');
  const config = productionConfig()
    .replace(`    password: ${ref('PROD_PASSWORD')}`, login)
    .replace(hostKeyLine, server.hostKeyLine);
  return createProject(config, site);
}

const bytesOf = (server: SftpServer) =>
  Object.fromEntries([...server.files()].map(([path, file]) => [path, file.bytes]));

describe('sealup deploy with a private key', () => {
  it('deploys, logging in with the key: one signed login, no password', async () => {
    const server = await sftpServer();
    const project = keyProject(server);

    const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(server) });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(server.files().has('/home/site/index.html')).toBe(true);
    expect(server.logins().map(({ method }) => method)).not.toContain('password');
    expect(server.logins().at(-1)).toEqual({ method: 'publickey', accepted: true });
    expectNoLeaks(bytesOf(server));
  });

  it('opens an encrypted key with its passphrase', async () => {
    // The passphrase is the canary password: the leak check covers it too.
    const passphrase = canaries.SEALUP_CANARY_PASSWORD;
    const key = userKey({ passphrase });
    const server = await sftpServer([key.publicLine]);
    const project = keyProject(server, { variable: 'DEPLOY_KEY', passphrase: true });

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { DEPLOY_KEY: key.private, KEY_PASSPHRASE: passphrase },
      connect: dialing(server),
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(server.files().has('/home/site/index.html')).toBe(true);
  });

  it('masks the whole key and each of its lines in GitHub, before anything else (R2)', async () => {
    const server = await sftpServer();
    const project = keyProject(server);

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: inGitHub,
      connect: dialing(server),
    });

    expect(run.exitCode, run.stderr).toBe(0);
    const { masks, rest } = splitMasks(run.stderr);
    const masked = masks.split('\n');
    const key = canaries.SEALUP_CANARY_KEY;
    expect(masked).toContain(`::add-mask::${key.replaceAll('\n', '%0A')}`);
    for (const line of key.split('\n').filter((text) => text.length >= 6)) {
      expect(masked).toContain(`::add-mask::${line}`);
    }
    expect(rest.split('\n')[0]).toBe(versionLine('deploy'));
  });

  it('reports a key the server refuses as a refused login, exit 3, tried once', async () => {
    const server = await sftpServer([userKey().publicLine]);
    const project = keyProject(server);

    const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(server) });

    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain(
      [
        '  ✗ Login refused by ssh.example.com for user deploy.',
        '    Check the key in SEALUP_CANARY_KEY (targets.production.privateKey): its public key',
        '    must be in ~/.ssh/authorized_keys for deploy on the server.',
        '    sealup never retries a refused login: hosts block an IP after failures.',
      ].join('\n'),
    );
    await server.closed();
    expect(server.logins()).toEqual([{ method: 'publickey', accepted: false }]);
  });
});

describe('sealup deploy: a key sealup cannot read (exit 2, decision 0033)', () => {
  it('says so in its own words, before connecting: nothing reaches the server', async () => {
    const server = await sftpServer();
    const project = keyProject(server, { variable: 'DEPLOY_KEY' });

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { DEPLOY_KEY: 'this is not a private key at all' },
      connect: dialing(server),
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy'),
          `  production  sftp://deploy@ssh.example.com:22/home/site`,
          '  host key    not checked',
          '',
          '  ✗ sealup cannot read the private key in DEPLOY_KEY.',
          `    targets.production.privateKey (sealup.yml line 5) reads ${ref('DEPLOY_KEY')}.`,
          '    It must be the whole key file (OpenSSH or PEM), as ssh-keygen writes it,',
          '    with its BEGIN and END lines.',
          '    In sealup.env, write it in double quotes, over several lines.',
          '',
          '    sealup did not connect. Nothing was changed on production.',
          '    More: sealup.dev/e/private-key-unreadable',
        ],
        { color: false },
      ),
    );
    await server.closed();
    expect(server.logins()).toEqual([]);
  });

  it('gives --json the slug and the fix', async () => {
    const server = await sftpServer();
    const project = keyProject(server, { variable: 'DEPLOY_KEY' });

    const run = await runMain(['deploy', '--json'], {
      cwd: project.root,
      env: { DEPLOY_KEY: 'this is not a private key at all' },
      connect: dialing(server),
    });

    expect(run.exitCode).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'failed',
      exitCode: 2,
      error: {
        code: 'private-key-unreadable',
        message: 'sealup cannot read the private key in DEPLOY_KEY.',
      },
    });
  });

  it('asks for the passphrase of an encrypted key given none', async () => {
    const key = userKey({ passphrase: canaries.SEALUP_CANARY_PASSWORD });
    const server = await sftpServer([key.publicLine]);
    const project = keyProject(server, { variable: 'DEPLOY_KEY' });

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { DEPLOY_KEY: key.private },
      connect: dialing(server),
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      [
        '  ✗ The private key in DEPLOY_KEY needs a passphrase.',
        '    It is encrypted. Next to targets.production.privateKey (line 5), add:',
        `      passphrase: ${ref('DEPLOY_KEY_PASSPHRASE')}`,
        '    and set DEPLOY_KEY_PASSPHRASE as you set DEPLOY_KEY.',
      ].join('\n'),
    );
  });

  it('refuses a wrong passphrase, naming both variables', async () => {
    const key = userKey({ passphrase: 'correct horse battery' });
    const server = await sftpServer([key.publicLine]);
    const project = keyProject(server, { variable: 'DEPLOY_KEY', passphrase: true });

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { DEPLOY_KEY: key.private, KEY_PASSPHRASE: canaries.SEALUP_CANARY_PASSWORD },
      connect: dialing(server),
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      [
        '  ✗ The passphrase in KEY_PASSPHRASE does not open the private key in DEPLOY_KEY.',
        `    targets.production.passphrase (sealup.yml line 6) reads ${ref('KEY_PASSPHRASE')}.`,
        '    Check that the two secrets belong together: the key file and its passphrase.',
      ].join('\n'),
    );
    expect(server.logins()).toEqual([]);
  });

  it('stops a pull the same way', async () => {
    const server = await sftpServer();
    const config = productionConfig()
      .replace(`    password: ${ref('PROD_PASSWORD')}`, `    privateKey: ${ref('DEPLOY_KEY')}`)
      .replace(hostKeyLine, server.hostKeyLine)
      .replace('targets:', 'pull:\n  www/resources: public_html/resources\ntargets:');
    const project = createProject(config, site);

    const run = await runMain(['pull'], {
      cwd: project.root,
      tty: true,
      env: { DEPLOY_KEY: 'this is not a private key at all' },
      connect: dialing(server),
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('sealup cannot read the private key in DEPLOY_KEY.');
  });
});

describe('sealup check: how each target logs in (decision 0033)', () => {
  it('names the password or the private key of each target', async () => {
    const config = [
      'upload: public_html',
      'targets:',
      '  production:',
      '    server: sftp://deploy@ssh.example.com/home/site',
      `    password: ${ref('PROD_PASSWORD')}`,
      `    hostKey: ${hostKeyLine}`,
      '  staging:',
      '    server: sftp://deploy@203.0.113.10/srv/site',
      `    privateKey: ${ref('STAGING_KEY')}`,
      `    hostKey: ${hostKeyLine}`,
      '',
    ].join('\n');
    const project = createProject(config, site);

    const run = await runMain(['check'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests', STAGING_KEY: canaries.SEALUP_CANARY_KEY },
    });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      '  ✓ Login: production with a password, staging with a private key\n',
    );
  });
});
