// `sealup init` through main() (spec #24 decisions 19-21; S02 is its golden): never overwriting,
// the questions and their refusals, Esc and Ctrl-C, no terminal with and without --server, the
// --json object, a project below the repo root, and over SFTP: no login during init, then a
// deploy logs in with the key and the password init saved.

import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { hostKeyPlaceholder } from '../../src/config/index.ts';
import { TransportError } from '../../src/contracts/index.ts';
import { canaries, createMemoryServer, expectNoLeaks, screenOf } from '../../src/testkit/index.ts';
import { hostKeyLine, newProject, ref, runMain, versionLine } from '../deploy-kit.ts';
import { dialing, scanDialing, testServer } from '../sftp-kit.ts';

const enter = '\r';
const esc = '\u001b';
const ctrlC = '\u0003';
const password = canaries.SEALUP_CANARY_PASSWORD;
const server = 'sftp://deploy@ssh.example.com/home/site';
const build = { 'dist/index.html': '<h1>home</h1>' };
/** Every answer of a run that goes well: the server, yes to the key, the password. */
const answers = [server, enter, 'y', enter, password, enter];

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

describe('init never overwrites', () => {
  it.each(['sealup.yml', 'sealup.yaml'])(
    'stops at once on an existing %s: exit 2, nothing asked, nothing written',
    async (name) => {
      const root = newProject({ ...build, [name]: 'upload: dist\n' });
      const run = await terminal(root, []);
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(`✗ ${name} is already here: sealup init never overwrites it.`);
      expect(run.stderr).toContain('Nothing was written.');
      expect(run.stderr).toContain('More: sealup.dev/e/config-exists');
      expect(readFileSync(join(root, name), 'utf8')).toBe('upload: dist\n');
      expect(exists(join(root, '.gitignore'))).toBe(false);
      expect(exists(join(root, '.github'))).toBe(false);
    },
  );

  it('leaves an existing workflow as it is, and says so in one line', async () => {
    const workflow = '.github/workflows/deploy.yml';
    const root = newProject({ ...build, [workflow]: 'name: mine\n' });
    const run = await terminal(root, answers);
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(root, workflow), 'utf8')).toBe('name: mine\n');
    const screen = screenOf(run.stderr);
    expect(screen).toContain(`  ${workflow} is there already: left as it is.\n`);
    expect(screen).not.toContain(`+ ${workflow}`);
  });

  it('asks no password when sealup.env already sets it, and leaves the file as it is', async () => {
    const root = newProject({ ...build, 'sealup.env': 'SEALUP_PASSWORD=already-set\n' });
    const run = await terminal(root, [server, enter, 'y', enter]);
    expect(run.exitCode).toBe(0);
    const screen = screenOf(run.stderr);
    expect(screen).toContain('  sealup.env already holds SEALUP_PASSWORD: it stays as it is.\n');
    expect(screen).not.toContain('Password for');
    expect(screen).not.toContain('sealup.env   ');
    expect(readFileSync(join(root, 'sealup.env'), 'utf8')).toBe('SEALUP_PASSWORD=already-set\n');
  });

  it('appends the password to a sealup.env without it, every other byte kept', async () => {
    const before = 'APP_ENV="one\ntwo"\n';
    const root = newProject({ ...build, 'sealup.env': before });
    const run = await terminal(root, answers);
    expect(run.exitCode).toBe(0);
    expect(screenOf(run.stderr)).toMatch(/\n {4}~ sealup\.env +added SEALUP_PASSWORD\n/);
    const text = readFileSync(join(root, 'sealup.env'), 'utf8');
    expect(text.startsWith(before)).toBe(true);
    expect(parseEnv(text)).toEqual({ APP_ENV: 'one\ntwo', SEALUP_PASSWORD: password });
  });

  // R17: the file now holds the password, so it is its owner's alone, whatever mode it had.
  it.skipIf(process.platform === 'win32')(
    'sets a sealup.env readable by others to 0600 when it appends',
    async () => {
      const root = newProject({ ...build, 'sealup.env': 'APP_ENV=x\n' });
      chmodSync(join(root, 'sealup.env'), 0o644);
      const run = await terminal(root, answers);
      expect(run.exitCode).toBe(0);
      expect(statSync(join(root, 'sealup.env')).mode & 0o777).toBe(0o600);
    },
  );

  it('adds the .gitignore line once, and makes the file when there is none', async () => {
    const already = newProject({ ...build, '.gitignore': 'dist\r\n/sealup.env\r\n' });
    const run = await terminal(already, answers);
    expect(readFileSync(join(already, '.gitignore'), 'utf8')).toBe('dist\r\n/sealup.env\r\n');
    expect(screenOf(run.stderr)).not.toContain('.gitignore');

    const none = newProject(build);
    const made = await terminal(none, answers);
    expect(readFileSync(join(none, '.gitignore'), 'utf8')).toBe('sealup.env\n');
    expect(screenOf(made.stderr)).toMatch(/\n {4}\+ \.gitignore +with the line sealup\.env\n/);

    const noBreak = newProject({ ...build, '.gitignore': 'dist\r\nnode_modules' });
    await terminal(noBreak, answers);
    expect(readFileSync(join(noBreak, '.gitignore'), 'utf8')).toBe(
      'dist\r\nnode_modules\r\nsealup.env\r\n',
    );
  });
});

describe('the questions', () => {
  it('asks for the upload folder when none is found, and refuses one outside the project', async () => {
    const root = newProject({ 'site/index.html': 'x' });
    const run = await terminal(root, ['../up', enter, './site/', enter, ...answers]);
    expect(run.exitCode).toBe(0);
    const screen = screenOf(run.stderr);
    expect(screen).toContain(
      '  Upload folder   none found in dist/, build/, out/, public/ or _site/\n',
    );
    expect(screen).toContain('  ✗ Name a folder inside this one, such as dist.\n');
    expect(screen).toContain('  Folder to upload: ./site/\n');
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toContain('\nupload: site\n');
  });

  it('says when there is no build script: the workflow has no build step', async () => {
    const root = newProject(build);
    const run = await terminal(root, answers);
    expect(screenOf(run.stderr)).toContain(
      '  Build           none  (no build script in package.json: the workflow only deploys)\n',
    );
    expect(screenOf(run.stderr)).toMatch(/workflows\/deploy\.yml +on push to main: deploy\n/);
    const workflow = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(workflow).not.toContain('Build');
  });

  it('refuses a server it cannot use, says why, and asks again', async () => {
    const root = newProject(build);
    const keys = [
      'ftpes://deploy@ssh.example.com/home/site',
      enter,
      `sftp://deploy:${password}@ssh.example.com/x`,
      enter,
      ...answers,
    ];
    const run = await terminal(root, keys);
    expect(run.exitCode).toBe(0);
    const screen = screenOf(run.stderr);
    // Both answers refused: an unknown protocol, and a password in the URL (R3).
    const refused = '  ✗ Not an address sealup can use: write it as sftp://user@host/folder.\n';
    expect(screen.split(refused)).toHaveLength(3);
  });

  it('refuses a password too short to hide, and asks again', async () => {
    const root = newProject(build);
    const run = await terminal(root, [server, enter, 'y', enter, 'abc', enter, password, enter]);
    expect(run.exitCode).toBe(0);
    expect(screenOf(run.stderr)).toContain(
      '  ✗ sealup cannot use this password: it has fewer than 6 characters, too short to hide in logs.\n',
    );
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8'))).toEqual({
      SEALUP_PASSWORD: password,
    });
  });

  it('writes the placeholder on a no to the key; keyscan then saves it there', async () => {
    const root = newProject(build);
    const run = await terminal(root, [server, enter, enter, password, enter]);
    expect(run.exitCode).toBe(0);
    const screen = screenOf(run.stderr);
    expect(screen).toContain('  ✓ Files written:\n');
    expect(screen).toMatch(/\+ sealup\.yml +server, password, upload: dist; no hostKey yet\n/);
    expect(screen).toContain("    sealup keyscan      check the server's key and save it\n");
    const file = join(root, 'sealup.yml');
    expect(readFileSync(file, 'utf8').split('\n')[2]).toBe(hostKeyPlaceholder);

    const keyscan = await terminal(root, ['y', enter], ['keyscan']);
    expect(keyscan.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8').split('\n')[2]).toBe(`hostKey: ${hostKeyLine}`);
  });

  it.each([
    ['Esc at the server', ['sftp', esc]],
    ['Ctrl-C at the key', [server, enter, ctrlC]],
    ['Esc at the password', [server, enter, 'y', enter, 'pass', esc]],
  ])('stops on %s: exit 130, nothing written', async (_, keys) => {
    const root = newProject(build);
    const run = await terminal(root, keys);
    expect(run.exitCode).toBe(130);
    expect(run.stderr).toContain('Stopped: the question was not answered.');
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
    expect(exists(join(root, '.gitignore'))).toBe(false);
  });

  it('stops when the server cannot be reached: exit 5, nothing written', async () => {
    const root = newProject(build);
    const run = await runMain(['init'], {
      cwd: root,
      tty: true,
      keys: [server, enter],
      env: { NO_COLOR: '1' },
      scan: async () => {
        throw new TransportError('unreachable', 'refused');
      },
    });
    expect(run.exitCode).toBe(5);
    expect(screenOf(run.stderr)).toContain('  host key    not checked\n');
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
  });
});

describe('without a terminal', () => {
  it('with --server: the placeholder, .gitignore and the workflow; no sealup.env, no connection', async () => {
    const root = newProject({ ...build, 'package.json': '{"scripts":{"build":"x"}}' });
    // No scan given: a run that scans fails the test.
    const run = await runMain(['init', '--server', server], { cwd: root });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toBe(
      [
        `server: ${server}`,
        `password: ${ref('SEALUP_PASSWORD')}`,
        hostKeyPlaceholder,
        'upload: dist',
        '',
      ].join('\n'),
    );
    expect(exists(join(root, 'sealup.env'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('sealup.env\n');
    expect(run.stderr).toBe(
      [
        versionLine('init'),
        '  Upload folder   dist/  (found, 1 file)',
        '  Build           npm run build  (from package.json, for the GitHub workflow)',
        '',
        '  ✓ Files written:',
        '    + sealup.yml                     server, password, upload: dist; no hostKey yet',
        '    + .gitignore                     with the line sealup.env',
        '    + .github/workflows/deploy.yml   on push to main: build, then deploy',
        '',
        "  On GitHub, add the secret SEALUP_PASSWORD with the server's password:",
        '  Settings › Secrets and variables › Actions › New repository secret',
        '',
        '  Next, on your computer:',
        "    sealup keyscan      check the server's key and save it",
        '    sealup deploy -n    dry run: list every change, change nothing',
        '    sealup deploy       deploy to ssh.example.com',
        '',
      ].join('\n'),
    );
  });

  it('takes an ssh:// server as written (0034)', async () => {
    const root = newProject(build);
    const ssh = 'ssh://deploy@ssh.example.com:2222/~/www';
    const run = await runMain(['init', '--server', ssh], { cwd: root });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toContain(`server: ${ssh}\n`);
  });

  it('takes dist when no upload folder is found, and says to change it if needed', async () => {
    const root = newProject({});
    const run = await runMain(['init', '--server', server], { cwd: root });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      '  Upload folder   dist/  (none found: change upload: in sealup.yml if needed)\n',
    );
  });

  it.each([
    [
      ['--server', 'ftpes://deploy@ssh.example.com/x'],
      '✗ The address given to --server is not one sealup can use.',
    ],
    [
      ['--server', `sftp://deploy:${password}@ssh.example.com/x`],
      '✗ The address given to --server is not one sealup can use.',
    ],
  ])('refuses %j with exit 2, nothing written, never printing it', async (flags, title) => {
    const root = newProject(build);
    const run = await runMain(['init', ...flags], { cwd: root });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(title);
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
  });

  it('asks nothing on a terminal whose input is piped: --server is needed there too', async () => {
    const root = newProject(build);
    const run = await runMain(['init'], { cwd: root, tty: true, stdinTTY: false });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('sealup init needs the server address.');
  });
});

describe('the typed password (leak test, R1)', () => {
  it('reaches sealup.env only: never the screen, --json, sealup.yml or the workflow', async () => {
    const root = newProject(build);
    // runMain looks for the canary in stdout, stderr and the JSON object.
    const run = await terminal(root, answers, ['init', '--json']);
    expect(run.exitCode).toBe(0);
    expectNoLeaks({
      'sealup.yml': readFileSync(join(root, 'sealup.yml'), 'utf8'),
      '.gitignore': readFileSync(join(root, '.gitignore'), 'utf8'),
      workflow: readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'),
    });
    expect(parseEnv(readFileSync(join(root, 'sealup.env'), 'utf8')).SEALUP_PASSWORD).toBe(password);
  });
});

describe('init and the command line', () => {
  it('gives the --json object of a stop: no file, the error', async () => {
    const root = newProject({ ...build, 'sealup.yml': 'upload: dist\n' });
    const run = await runMain(['init', '--json'], { cwd: root });
    expect(JSON.parse(run.stdout)).toMatchObject({
      command: 'init',
      status: 'failed',
      exitCode: 2,
      files: [],
      error: { code: 'config-exists' },
    });
  });

  it('takes no target name, and --server belongs to init only', async () => {
    const root = newProject(build);
    const named = await runMain(['init', 'production'], { cwd: root });
    expect(named.exitCode).toBe(2);
    expect(named.stderr).toContain('✗ init takes no target name: it sets up this folder.');
    const deploy = await runMain(['deploy', '--server', server], { cwd: root });
    expect(deploy.exitCode).toBe(2);
    expect(deploy.stderr).toContain('✗ Unknown flag --server.');
  });

  // A flag init cannot honour is refused, never ignored (cli's rule): it writes in this folder,
  // reads no config or env file, and has no dry run, -v or -q.
  it.each([
    [['-c', 'other.yml'], '-c'],
    [['--config', 'other.yml'], '--config'],
    [['--env-file', 'prod.env'], '--env-file'],
    [['-n'], '-n'],
    [['--dry-run'], '--dry-run'],
    [['-v'], '-v'],
    [['-q'], '-q'],
  ])('refuses %j: exit 2 naming the flag, nothing written', async (flags, flag) => {
    const root = newProject(build);
    const run = await runMain(['init', '--server', server, ...flags], { cwd: root });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(`✗ init does not take ${flag}.`);
    expect(exists(join(root, 'sealup.yml'))).toBe(false);
  });

  it('writes the workflow at the repo root for a project below it', async () => {
    const repo = newProject({ 'site/dist/index.html': 'x' });
    const run = await terminal(join(repo, 'site'), answers);
    expect(run.exitCode).toBe(0);
    expect(screenOf(run.stderr)).toMatch(/\+ \.\.\/\.github\/workflows\/deploy\.yml +on push/);
    const workflow = readFileSync(join(repo, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(workflow).toContain('          working-directory: site\n');
    expect(exists(join(repo, 'site', 'sealup.yml'))).toBe(true);
  });

  it('over SFTP: no login during init, then a deploy logs in with what init saved', async () => {
    const sftp = await testServer({ password });
    const root = newProject(build);
    writeFileSync(join(root, '.gitignore'), '');
    const run = await runMain(['init'], {
      cwd: root,
      tty: true,
      keys: answers,
      scan: scanDialing(sftp),
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(sftp.logins()).toEqual([]);
    const deployed = await runMain(['deploy'], { cwd: root, connect: dialing(sftp) });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(sftp.logins()).toEqual([{ method: 'password', accepted: true }]);
  });
});
