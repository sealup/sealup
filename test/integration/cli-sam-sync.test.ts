// The sam-sync conversion through main() (spec #24 decision 22; S03 is its golden): offered on a
// terminal only when a .deployment.json is there, `--from` without a terminal (the host-key
// placeholder), the refusals (another flag, an unreadable file), plain FTP, what it cannot move,
// and the converted project then passing `sealup check` and deploying, its secret file written
// from APP_ENV. The sam-sync files are synthetic (test/sam-sync-kit.ts).

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { hostKeyPlaceholder } from '../../src/config/index.ts';
import {
  canaries,
  createMemoryServer,
  expectNoLeaks,
  screenOf,
  splitMasks,
} from '../../src/testkit/index.ts';
import {
  canaryMasks,
  hostKeyLine,
  inGitHub,
  newProject,
  runMain,
  siteFiles,
  versionLine,
} from '../deploy-kit.ts';
import { samSyncDeployment, samSyncDownload, samSyncProject } from '../sam-sync-kit.ts';

const enter = '\r';
const esc = '\u001b';
const password = canaries.SEALUP_CANARY_PASSWORD;
const appEnv = canaries.SEALUP_CANARY_MULTILINE;

const exists = (path: string): boolean => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

function terminal(root: string, keys: readonly string[], argv: readonly string[] = ['init']) {
  return runMain(argv, {
    cwd: root,
    tty: true,
    keys,
    scan: createMemoryServer().scanHostKey,
    env: { NO_COLOR: '1' },
  });
}

describe('the offer, on a terminal', () => {
  it('is made only when a .deployment.json is there', async () => {
    const root = newProject({ 'dist/index.html': 'x' });
    const run = await terminal(root, [
      'sftp://deploy@ssh.example.com/home/site',
      enter,
      'n',
      enter,
      enter,
      password,
      enter,
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toMatch(/sam-sync|Convert/);
  });

  it('names .deployment.json alone when there is no .download.json', async () => {
    const root = newProject(samSyncProject(samSyncDeployment, null));
    const run = await terminal(root, [esc]);
    expect(screenOf(run.stderr)).toContain('  Found a sam-sync setup: .deployment.json.\n');
  });

  it('goes on with the questions of a new project on a no', async () => {
    const root = newProject(samSyncProject());
    const run = await terminal(root, [
      'n',
      enter,
      'public_html',
      enter,
      'sftp://deploy@ssh.example.com/home/site/www',
      enter,
      'y',
      enter,
      enter,
      password,
      enter,
    ]);
    expect(run.exitCode, run.stderr).toBe(0);
    const screen = screenOf(run.stderr);
    expect(screen).toContain('  Convert it to sealup.yml? [Y/n] n\n\n  Upload folder ');
    expect(screen).not.toContain('Converted:');
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toContain('upload: public_html\n');
  });

  it('stops on Esc at the offer: exit 130, nothing written', async () => {
    const root = newProject(samSyncProject());
    const run = await terminal(root, [esc]);
    expect(run.exitCode).toBe(130);
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
    expect(exists(join(root, 'sealup.env'))).toBe(false);
    expect(exists(join(root, '.github'))).toBe(false);
  });

  it('stops on Esc at the host key: exit 130, nothing written', async () => {
    const root = newProject(samSyncProject());
    const run = await terminal(root, ['y', enter, esc]);
    expect(run.exitCode).toBe(130);
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
    expect(exists(join(root, 'sealup.env'))).toBe(false);
  });

  it('is not made with --server: the address given wins', async () => {
    const root = newProject(samSyncProject());
    const run = await terminal(
      root,
      ['public_html', enter, 'y', enter, enter, password, enter],
      ['init', '--server', 'sftp://deploy@ssh.example.com/home/site/www'],
    );
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('sam-sync');
  });

  it('asks for the password when the files hold none, and keeps the rest', async () => {
    const { password: _, ...noPassword } = samSyncDeployment;
    const root = newProject(samSyncProject(noPassword, null));
    const run = await terminal(root, ['y', enter, 'y', enter, enter, password, enter]);
    expect(run.exitCode, run.stderr).toBe(0);
    const screen = screenOf(run.stderr);
    expect(screen).toContain('    1 secret        APP_ENV (api/.env.prod)\n');
    expect(screen).toContain(
      `  Password for deploy@ssh.example.com: ${'•'.repeat(password.length)}\n`,
    );
    expect(screen).toContain('  ! The old sam-sync files are not needed any more.\n');
    expect(screen).not.toContain('Then change the password');
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
      APP_ENV: appEnv,
    });
  });
});

describe('--from, without a terminal', () => {
  it('converts with the host-key placeholder, never scanning, and moves the secrets', async () => {
    const root = newProject(samSyncProject());
    // runMain has no scan here: a scan would fail the run.
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config.split('\n')[2]).toBe(hostKeyPlaceholder);
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
      APP_ENV: appEnv,
    });
    expect(run.stderr).toContain(
      '    + sealup.yml                     from your 2 sam-sync files; no hostKey yet\n',
    );
    expect(run.stderr).toContain('  Next, on your computer:\n    sealup keyscan ');
    expect(run.stderr).toContain(
      '  ! The old sam-sync files hold your password, and git history keeps it.\n',
    );
    expect(run.stderr).not.toContain('Convert it');
    expect(run.stderr).not.toContain("sam-sync never checked the server's identity");
  });

  // R2, spec #24 decision 30: the password and the secret file's content are secrets the run
  // read, so GitHub's form masks them before any other byte (runMain checks the rest for leaks).
  it("masks the sam-sync password and the .env file's content first in GitHub's form", async () => {
    const root = newProject(samSyncProject());
    const run = await runMain(['init', '--from', '.deployment.json'], {
      cwd: root,
      env: inGitHub,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    const { masks, rest } = splitMasks(run.stderr);
    for (const mask of canaryMasks) expect(masks.split('\n')).toContain(mask);
    expect(masks.split('\n')).toContain('::add-mask::Cn4ry-second-line-fake');
    expect(rest.split('\n')[0]).toBe(versionLine('init'));
  });

  it('takes another file, and its download file beside it', async () => {
    const root = newProject({
      ...samSyncProject(samSyncDeployment, null),
      '.deployment.prod.json': JSON.stringify({
        ...samSyncDeployment,
        remotePrefix: '/home/prod/',
      }),
      '.download.prod.json': JSON.stringify({ ...samSyncDownload, remotePrefix: '/home/prod/' }),
    });
    const run = await runMain(['init', '--from', '.deployment.prod.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config).toContain('server: sftp://deploy@ssh.example.com/home/prod\n');
    expect(config).toContain('pull:\n  www/resources: public_html/resources\n');
    expect(run.stderr).toContain('git rm .deployment.prod.json .download.prod.json  then');
  });

  it('refuses --from with --server, and --from on another command (exit 2)', async () => {
    const root = newProject(samSyncProject());
    const both = await runMain(
      ['init', '--from', '.deployment.json', '--server', 'sftp://deploy@ssh.example.com/x'],
      { cwd: root },
    );
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain('✗ --from and --server cannot be used together.');
    const deploy = await runMain(['deploy', '--from', '.deployment.json'], { cwd: root });
    expect(deploy.exitCode).toBe(2);
    expect(deploy.stderr).toContain('✗ Unknown flag --from.');
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
  });

  it.each([
    ['a file that is not there', { 'dist/index.html': 'x' }, 'missing.json'],
    ['a file that is not JSON', { 'old.json': '{ nope' }, 'old.json'],
    ['a file without host', { 'old.json': '{"user":"deploy"}' }, 'old.json'],
  ])('stops on %s: exit 2, nothing written', async (_, files, file) => {
    const root = newProject(files);
    const run = await runMain(['init', '--from', file], { cwd: root });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(`✗ sealup cannot read ${file} as a sam-sync config.`);
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
  });

  it('converts plain FTP to ftp://, with no host key to check (spec #41 decision 18)', async () => {
    const ftp = { ...samSyncDeployment, type: 'ftp', port: 21 };
    const root = newProject(samSyncProject(ftp, null));
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config).toContain('server: ftp://deploy@ssh.example.com/home/site\n');
    expect(config).not.toContain('hostKey');
    expect(run.stderr).not.toContain('keyscan');
    expect(run.stderr).not.toContain('no hostKey yet');
  });
});

describe('what the conversion cannot move', () => {
  it('says so when the file of a secret is not there, and writes the rest', async () => {
    const files = samSyncProject(samSyncDeployment, null);
    delete files['api/.env.prod'];
    const root = newProject(files);
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      '  APP_ENV: api/.env.prod is not here. Put its content in sealup.env as APP_ENV.\n',
    );
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
    });
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toContain(`  api/.env: $\{APP_ENV}\n`);
  });

  it("reads an env file's CRLF line breaks as LF: sealup.env holds no CR", async () => {
    const root = newProject({
      ...samSyncProject(samSyncDeployment, null),
      'api/.env.prod': 'APP_KEY=base64:c2VjcmV0\r\nDB_PASSWORD=p4ssw0rd\r\n',
    });
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8')).APP_ENV).toBe(
      'APP_KEY=base64:c2VjcmV0\nDB_PASSWORD=p4ssw0rd\n',
    );
  });

  it('says what it left out, a .download.json on another server, and the pull excludes', async () => {
    const root = newProject(
      samSyncProject(
        {
          ...samSyncDeployment,
          up: {
            ...samSyncDeployment.up,
            directories: [{ source: './' }, ...samSyncDeployment.up.directories],
          },
          down: { directories: [{ source: 'www/cache/', destin: 'cache/', excludes: ['/tmp'] }] },
        },
        { ...samSyncDownload, host: 'other.example.com' },
      ),
    );
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      '  .download.json uses another server: it was left out (sealup pulls from the\n  server it deploys to).\n',
    );
    expect(run.stderr).toContain('  sealup pull has no exclude: /tmp will come down too.\n');
    expect(run.stderr).toContain(
      '  Left out: ./ → ./: sealup never sends or pulls into this whole folder (it\n  holds sealup.env).\n',
    );
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toContain('pull:\n  www/cache: cache\n');
  });
});

describe('the converted project', () => {
  it('passes sealup check, then deploys, its .env written from APP_ENV', async () => {
    const root = newProject(samSyncProject());
    const converted = await runMain(['init'], {
      cwd: root,
      tty: true,
      keys: ['y', enter, 'y', enter, enter],
      scan: createMemoryServer().scanHostKey,
    });
    expect(converted.exitCode, converted.stderr).toBe(0);
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toContain(`hostKey: ${hostKeyLine}`);

    const checked = await runMain(['check'], { cwd: root });
    expect(checked.exitCode, checked.stderr).toBe(0);

    const server = createMemoryServer({ loginFolder: '/home/deploy', quick: true });
    const deployed = await runMain(['deploy'], { cwd: root, server });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(siteFiles(server)).toEqual(['api/.env', 'api/index.php', 'www/index.html']);
    const env = server.files().get('/home/site/api/.env');
    expect(Buffer.from(env?.bytes ?? []).toString('utf8')).toBe(appEnv);
    expect(env?.mode).toBe(0o600);
    expectNoLeaks({
      'sealup.yml': readFileSync(join(root, 'sealup.yml'), 'utf8'),
      workflow: readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'),
    });
  });

  // Decision 0045: the conversion asks the public question too, with the same result.
  it('in a public repository: the server and key from sealup.env, then deploys', async () => {
    const root = newProject(samSyncProject());
    const converted = await runMain(['init'], {
      cwd: root,
      tty: true,
      keys: ['y', enter, 'y', enter, 'y', enter],
      scan: createMemoryServer().scanHostKey,
      env: { NO_COLOR: '1' },
    });
    expect(converted.exitCode, converted.stderr).toBe(0);
    const screen = screenOf(converted.stderr);
    expect(screen).toContain(
      '  Save it to sealup.yml as hostKey? [y/N] y\n\n  Anyone can read sealup.yml in a public repository.',
    );
    expect(screen).toContain('  Is this repository public? [y/N] y\n');
    expect(screen).toContain(
      '  On GitHub, add the secrets SEALUP_PASSWORD, APP_ENV, SEALUP_SERVER and SEALUP_HOST_KEY:\n  Settings › Secrets and variables › Actions › New repository secret\n  Copy each value from sealup.env.\n',
    );
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config.split('\n').slice(0, 4)).toEqual([
      `server: $\{SEALUP_SERVER}`,
      `password: $\{SEALUP_PASSWORD}`,
      `hostKey: $\{SEALUP_HOST_KEY}`,
      'upload:',
    ]);
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
      APP_ENV: appEnv,
      SEALUP_SERVER: 'sftp://deploy@ssh.example.com/home/site',
      SEALUP_HOST_KEY: hostKeyLine,
    });
    const workflow = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
    for (const name of ['SEALUP_PASSWORD', 'APP_ENV', 'SEALUP_SERVER', 'SEALUP_HOST_KEY']) {
      expect(workflow).toContain(`          ${name}: $\{{ secrets.${name} }}\n`);
    }

    const server = createMemoryServer({ loginFolder: '/home/deploy', quick: true });
    const deployed = await runMain(['deploy'], { cwd: root, server });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(siteFiles(server)).toEqual(['api/.env', 'api/index.php', 'www/index.html']);
  });

  // Decision 0038: a `~/` prefix becomes a `/~` target; the default manifest sits beside www/.
  it('converts a ~/ prefix to /~, then passes check and deploys with the default manifest', async () => {
    const fromLogin = { remotePrefix: '~/' };
    const root = newProject(
      samSyncProject({ ...samSyncDeployment, ...fromLogin }, { ...samSyncDownload, ...fromLogin }),
    );
    const converted = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(converted.exitCode, converted.stderr).toBe(0);
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config).toContain('/~\n');
    expect(config).not.toContain('manifest:');
    // --from leaves the host-key placeholder: the test pins the memory server's key.
    const pinned = config.replace(hostKeyPlaceholder, `hostKey: ${hostKeyLine}`);
    writeFileSync(join(root, 'sealup.yml'), pinned);

    const checked = await runMain(['check'], { cwd: root });
    expect(checked.exitCode, checked.stderr).toBe(0);

    const server = createMemoryServer({ loginFolder: '/home/deploy', quick: true });
    const deployed = await runMain(['deploy'], { cwd: root, server });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    const files = [...server.files().keys()].sort();
    expect(files.filter((path) => !path.startsWith('/home/deploy/.sealup/'))).toEqual([
      '/home/deploy/api/.env',
      '/home/deploy/api/index.php',
      '/home/deploy/www/index.html',
    ]);
    expect(files.filter((path) => path.startsWith('/home/deploy/.sealup/'))).toHaveLength(1);
  });
});
