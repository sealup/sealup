// The sam-sync conversion through main() (spec #24 decision 22; S03 is its golden): offered on a
// terminal only when a .deployment.json is there, `--from` without a terminal (the host-key
// placeholder), the refusals (another flag, an unreadable file), plain FTP, what it cannot move,
// and the converted project then passing `sealup check` and deploying, its secret file written
// from APP_ENV. The sam-sync files are synthetic (test/sam-sync-kit.ts).

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../../scripts/git-env.ts';
import { hostKeyPlaceholder } from '../../src/config/index.ts';
import { ExitCode } from '../../src/contracts/index.ts';
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
    expect(screen).not.toContain('APP_ENV');
    expect(screen).toContain(
      `  Password for deploy@ssh.example.com: ${'•'.repeat(password.length)}\n`,
    );
    expect(screen).toContain('  ! The old sam-sync files are not needed any more.\n');
    expect(screen).not.toContain('Then change the password');
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
    });
  });
});

describe('--from, without a terminal', () => {
  it('converts a pull-only project into loadable shorthand and actually pulls', async () => {
    const root = newProject(
      samSyncProject(
        {
          ...samSyncDeployment,
          up: undefined,
          down: { files: [{ source: 'api/data.json', destin: 'data/received.json' }] },
        },
        null,
      ),
    );
    const converted = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(converted.exitCode, converted.stderr).toBe(0);
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config).toContain('upload: {}\n');
    writeFileSync(
      join(root, 'sealup.yml'),
      config.replace(hostKeyPlaceholder, `hostKey: ${hostKeyLine}`),
    );
    const checked = await runMain(['check'], { cwd: root });
    expect(checked.exitCode, checked.stderr).toBe(0);
    const server = createMemoryServer({ loginFolder: '/home/deploy', quick: true });
    server.seedFile('/home/site/api/data.json', 'synthetic-user-data');
    const pulled = await runMain(['pull'], { cwd: root, server, tty: true });
    expect(pulled.exitCode, pulled.stderr).toBe(0);
    expect(readFileSync(join(root, 'data/received.json'), 'utf8')).toBe('synthetic-user-data');
  });

  it.each([
    ['no entries', { host: 'ssh.example.com', user: 'deploy' }],
    ['only omitted entries', { ...samSyncDeployment, up: { directories: [{ source: './' }] } }],
  ])('refuses conversion with %s before writing an empty config', async (_, legacy) => {
    const root = newProject(samSyncProject(legacy, null));
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('has no upload or pull entries sealup can convert');
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
    expect(exists(join(root, 'sealup.env'))).toBe(false);
    expect(exists(join(root, '.github/workflows/deploy.yml'))).toBe(false);
  });

  it('converts with the host-key placeholder, never scanning, and moves the secrets', async () => {
    const root = newProject(samSyncProject());
    // runMain has no scan here: a scan would fail the run.
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config.split('\n')[2]).toBe(hostKeyPlaceholder);
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
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

  // R2: only the connection password is read, and GitHub masks it before output.
  it('masks the sam-sync password without reading or masking application env contents', async () => {
    const root = newProject(samSyncProject());
    const run = await runMain(['init', '--from', '.deployment.json'], {
      cwd: root,
      env: inGitHub,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    const { masks, rest } = splitMasks(run.stderr);
    for (const mask of canaryMasks) expect(masks.split('\n')).toContain(mask);
    expect(masks).not.toContain('::add-mask::Cn4ry-second-line-fake');
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
  it('adds literal Git ignore rules for unusual env filenames and later negations', async () => {
    const sources = [
      'api/.env prod',
      'api/.env[prod]',
      'api/.env*.prod',
      'api/.env?.prod',
      '!draft/.env.prod',
      '#draft/.env.prod',
    ];
    const root = newProject({
      ...samSyncProject(
        {
          ...samSyncDeployment,
          up: { files: sources.map((source, index) => ({ source, destin: `api/.env.${index}` })) },
        },
        null,
      ),
      '.gitignore': '/api/.env[prod]\n!/api/.env[prod]\nsealup.env\n!sealup.env\n',
    });
    const isolatedGitEnv = gitEnv({ GIT_CONFIG_GLOBAL: '', GIT_CONFIG_NOSYSTEM: '1' });
    execFileSync('git', ['init', '--quiet'], { cwd: root, env: isolatedGitEnv });
    const converted = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(converted.exitCode, converted.stderr).toBe(0);
    const input = [...sources, 'sealup.env', 'api/.envp', 'api/.envwild.prod', 'api/.envx.prod'];
    const ignored = execFileSync(
      'git',
      ['-c', 'core.excludesFile=', 'check-ignore', '--no-index', '--stdin', '-z'],
      {
        cwd: root,
        env: isolatedGitEnv,
        input: `${input.join('\0')}\0`,
        encoding: 'utf8',
      },
    )
      .split('\0')
      .filter(Boolean);
    expect(ignored).toEqual([...sources, 'sealup.env']);
  });

  it('ignores every direct env source, even when absent, without copying app secrets', async () => {
    const files = samSyncProject(
      {
        ...samSyncDeployment,
        up: {
          ...samSyncDeployment.up,
          files: [
            { source: 'api/.env.prod', destin: 'api/.env' },
            { source: 'api/.env.missing', destin: 'designer/.env' },
          ],
        },
      },
      null,
    );
    const root = newProject(files);
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    const ignored = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(ignored).toContain('/api/.env.prod\n');
    expect(ignored).toContain('/api/.env.missing\n');
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config).toContain('api/.env.missing: designer/.env');
    expect(config).not.toContain('APP_ENV');
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
    });
    expect(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')).not.toContain(
      'APP_ENV',
    );
  });

  it('retains a missing env file mapping so check reports the required source', async () => {
    const files = samSyncProject(samSyncDeployment, null);
    delete files['api/.env.prod'];
    const root = newProject(files);
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('APP_ENV');
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
    });
    const config = readFileSync(join(root, 'sealup.yml'), 'utf8');
    expect(config).toContain('  api/.env.prod: api/.env\n');
    writeFileSync(
      join(root, 'sealup.yml'),
      config.replace(hostKeyPlaceholder, `hostKey: ${hostKeyLine}`),
    );
    const checked = await runMain(['check'], { cwd: root });
    expect(checked.exitCode).toBe(ExitCode.safetyNet);
    expect(checked.stderr).toContain('api/.env.prod');
  });

  it("leaves an env file's CRLF bytes untouched without snapshotting it", async () => {
    const root = newProject({
      ...samSyncProject(samSyncDeployment, null),
      'api/.env.prod': 'APP_KEY=base64:c2VjcmV0\r\nDB_PASSWORD=p4ssw0rd\r\n',
    });
    const run = await runMain(['init', '--from', '.deployment.json'], { cwd: root });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
    });
    expect(readFileSync(join(root, 'api/.env.prod'), 'utf8')).toBe(
      'APP_KEY=base64:c2VjcmV0\r\nDB_PASSWORD=p4ssw0rd\r\n',
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
  it('deploys repeated sources to both instances with independent exclusions and direct env files', async () => {
    const root = newProject({
      ...samSyncProject(
        {
          ...samSyncDeployment,
          up: {
            directories: [
              { source: 'api/', destin: 'main/api/', excludes: ['/.env*', '/storage'] },
              { source: 'api/', destin: 'designer/api/', excludes: ['/.env*', '/cache'] },
            ],
            files: [
              { source: 'api/.env.prod', destin: 'main/api/.env' },
              { source: 'api/.env.designer.prod', destin: 'designer/api/.env' },
            ],
          },
        },
        null,
      ),
      'api/.env.prod': 'INSTANCE=main\n',
      'api/.env.designer.prod': 'INSTANCE=designer\n',
      'api/cache/generated.txt': 'main-only-cache',
    });
    const converted = await terminal(root, ['y', enter, 'y', enter, enter]);
    expect(converted.exitCode, converted.stderr).toBe(0);
    const checked = await runMain(['check'], { cwd: root });
    expect(checked.exitCode, checked.stderr).toBe(0);
    const server = createMemoryServer({ loginFolder: '/home/deploy', quick: true });
    server.seedFile('/home/site/main/api/storage/user.txt', 'keep-main-user-data');
    server.seedFile('/home/site/designer/api/cache/user.txt', 'keep-designer-user-data');
    const deployed = await runMain(['deploy'], { cwd: root, server });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(siteFiles(server)).toEqual([
      'designer/api/.env',
      'designer/api/cache/user.txt',
      'designer/api/index.php',
      'designer/api/storage/log.txt',
      'main/api/.env',
      'main/api/cache/generated.txt',
      'main/api/index.php',
      'main/api/storage/user.txt',
    ]);
    expect(
      Buffer.from(server.files().get('/home/site/main/api/.env')?.bytes ?? []).toString('utf8'),
    ).toBe('INSTANCE=main\n');
    expect(
      Buffer.from(server.files().get('/home/site/designer/api/.env')?.bytes ?? []).toString('utf8'),
    ).toBe('INSTANCE=designer\n');
  });

  it('passes sealup check and deploys the current env file bytes on each run', async () => {
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
    expect(env?.mode).toBe(0o644);
    const changed = 'APP_ENV=changed\r\nDB_PASSWORD=current-secret\r\n';
    writeFileSync(join(root, 'api/.env.prod'), changed);
    const redeployed = await runMain(['deploy'], { cwd: root, server });
    expect(redeployed.exitCode, redeployed.stderr).toBe(0);
    expect(
      Buffer.from(server.files().get('/home/site/api/.env')?.bytes ?? []).toString('utf8'),
    ).toBe(changed);
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
      '  On GitHub, add the secrets SEALUP_PASSWORD, SEALUP_SERVER and SEALUP_HOST_KEY:\n  Settings › Secrets and variables › Actions › New repository secret\n  Copy each value from sealup.env.\n',
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
      SEALUP_SERVER: 'sftp://deploy@ssh.example.com/home/site',
      SEALUP_HOST_KEY: hostKeyLine,
    });
    const workflow = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
    for (const name of ['SEALUP_PASSWORD', 'SEALUP_SERVER', 'SEALUP_HOST_KEY']) {
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
