// Golden S02, "Set up a new project" (CLI page, docs/exploration/assets/06/
// scenarios-start-daily.js; spec #24 decisions 19-21). `sealup init` in a project with a dist/
// build folder and a build script: it asks for the server address and the password only, shows
// the server's key and saves it on a yes, asks whether the repository is public (0045: on a yes
// the server and the key go to sealup.env and the workflow's secrets), writes every file and says
// what is left (exit 0).
// Without a terminal it stops with exit 2 and names the flag, unless --server is given. The
// workflow's sealup step names sealup's version tag (decision 0043).
//
// Adapted, each on purpose:
// - dist/ holds 3 files (the page's 214 is its mockup's count).
// - The target block's label is the shorthand target's name, its host (ruling 4), as keyscan's
//   and a deploy's target block print it, not the page's `server`.
// - The password typed is the canary (25 characters, so 25 `•`), which the leak test then looks
//   for everywhere; the page shows 8.
// - In CI the `(or --from .deployment.json …)` line is there only when a .deployment.json is
//   (spec #24 decision 20), as in the GitHub form below; the plain log has none.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { canaries, createMemoryServer, goldenText, screenOf } from '../../../src/testkit/index.ts';
import { hostKeyLine, inGitHub, newProject, ref, runMain, versionLine } from '../../deploy-kit.ts';
import { expectFrozenJson } from '../../freeze-kit.ts';

const password = canaries.SEALUP_CANARY_PASSWORD;
const server = 'sftp://deploy@ssh.example.com/home/site/www';

const files = {
  'dist/index.html': '<h1>home</h1>',
  'dist/assets/app.js': 'app',
  'dist/assets/app.css': 'css',
  'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
  'package-lock.json': '{}',
  '.gitignore': 'node_modules\n',
};

/** The screen up to the public question's answer (0045): `y` or `n`. */
const s02Questions = (publicAnswer: 'y' | 'n') => [
  '  Upload folder   dist/  {d}(found, 3 files){/}',
  '  Build           npm run build  {d}(from package.json, for the GitHub workflow){/}',
  '',
  '  {d}Where should it go? A URL like sftp://user@host/folder{/}',
  '  {d}(also ssh://, ftps://, or ftp:// for plain FTP){/}',
  `  Server address: ${server}`,
  '',
  '  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site/www',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {y}not saved{/}',
  '',
  "  This is the server's ED25519 key. Compare the fingerprint with the one in",
  "  your host's control panel (SSH settings), or ask their support.",
  '  If they match, this is your server.',
  '  Save it to sealup.yml as hostKey? [y/N] y',
  '',
  '  {d}Anyone can read sealup.yml in a public repository. sealup can keep the server{/}',
  '  {d}and its host key out of it: in sealup.env here, and in secrets on GitHub.{/}',
  `  Is this repository public? [y/N] ${publicAnswer}`,
  '',
  '  {d}The password goes in sealup.env, which stays on this machine (git-ignored).{/}',
  `  Password for deploy@ssh.example.com: ${'•'.repeat(password.length)}`,
  '',
  '  {gb}✓ This project is set up.{/} Files written:',
  '    {g}+{/} sealup.yml                     server, password, hostKey, upload: dist',
];

const s02 = [
  ...s02Questions('n'),
  '    {g}+{/} sealup.env                     SEALUP_PASSWORD (git-ignored)',
  '    ~ .gitignore                     added the line sealup.env',
  '    {g}+{/} .github/workflows/deploy.yml   on push to main: build, then deploy',
  '',
  '  On GitHub, add the secret {b}SEALUP_PASSWORD{/} with the same password:',
  '  {d}Settings › Secrets and variables › Actions › New repository secret{/}',
  '',
  '  {b}Next:{/}',
  '    sealup deploy --dry-run    dry run: list every change, change nothing',
  '    sealup deploy              deploy to ssh.example.com',
];

/** A public repository (0045): the server and the host key go to sealup.env and to secrets. */
const s02Public = [
  ...s02Questions('y'),
  '    {g}+{/} sealup.env                     SEALUP_PASSWORD, SEALUP_SERVER, SEALUP_HOST_KEY (git-ignored)',
  '    ~ .gitignore                     added the line sealup.env',
  '    {g}+{/} .github/workflows/deploy.yml   on push to main: build, then deploy',
  '',
  '  On GitHub, add the secrets {b}SEALUP_PASSWORD{/}, {b}SEALUP_SERVER{/} and {b}SEALUP_HOST_KEY{/}:',
  '  {d}Settings › Secrets and variables › Actions › New repository secret{/}',
  '  {d}Copy each value from sealup.env.{/}',
  '',
  '  {b}Next:{/}',
  '    sealup deploy --dry-run    dry run: list every change, change nothing',
  '    sealup deploy              deploy to ssh.example.com',
];

const keys = [server, '\r', 'y', '\r', '\r', password, '\r'];

/**
 * The workflow init writes for this project (npm and a build), sealup's step by its version tag,
 * and the variables it passes from secrets.
 */
const workflow = (version: string, variables: readonly string[] = ['SEALUP_PASSWORD']): string =>
  [
    '# Deploys with sealup on every push to main (written by sealup init).',
    `# Secrets go through env:, never as inputs: sealup.yml reads them as $\{NAME}.`,
    'name: Deploy',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    '# One deploy at a time: a newer push waits, and a running deploy is never cancelled.',
    'concurrency:',
    '  group: sealup-production',
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    environment:',
    '      name: production',
    `      url: $\{{ steps.sealup.outputs.url }}`,
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    '        with:',
    '          persist-credentials: false',
    '',
    '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
    '        with:',
    '          node-version: 24',
    '',
    '      - name: Build',
    '        run: npm ci && npm run build',
    '',
    `      - uses: sealup/sealup@v${version}`,
    '        id: sealup',
    '        env:',
    ...variables.map((name) => `          ${name}: $\{{ secrets.${name} }}`),
    '',
  ].join('\n');

const ci = (fromLine: boolean) => [
  '  {rb}✗{/} {b}sealup init needs the server address.{/}',
  '    There is no terminal to ask in, so pass it as a flag:',
  '    sealup init --server sftp://user@host/folder',
  ...(fromLine ? ['    (or --from .deployment.json to convert a sam-sync config)'] : []),
  '',
  '    Nothing was written.',
  '    {d}More: sealup.dev/e/no-terminal{/}',
];

describe('S02: set up a new project', () => {
  it('asks for the server and the password on a terminal, and writes every file', async () => {
    const root = newProject(files);
    const scan = createMemoryServer();
    const run = await runMain(['init'], { cwd: root, tty: true, keys, scan: scan.scanHostKey });
    expect(screenOf(run.stderr)).toBe(goldenText(s02, { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(0);
    expect(scan.logins()).toEqual([]);

    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toBe(
      [
        `server: ${server}`,
        `password: ${ref('SEALUP_PASSWORD')}`,
        `hostKey: ${hostKeyLine}`,
        'upload: dist',
        '',
      ].join('\n'),
    );
    const env = readFileSync(join(root, 'sealup.env'), 'utf8');
    expect(parseEnv(env)).toEqual({ SEALUP_PASSWORD: password });
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'sealup.env')).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\nsealup.env\n');
    expect(readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8')).toBe(
      workflow('0.0.0-source'),
    );
  });

  // Decision 0045: on a yes, sealup.yml names the server and the key; their values are local.
  it('keeps the server and the host key out of sealup.yml in a public repository', async () => {
    const root = newProject(files);
    const scan = createMemoryServer();
    const run = await runMain(['init'], {
      cwd: root,
      tty: true,
      keys: [server, '\r', 'y', '\r', 'y', '\r', password, '\r'],
      scan: scan.scanHostKey,
    });
    expect(screenOf(run.stderr)).toBe(goldenText(s02Public, { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(0);
    expect(scan.logins()).toEqual([]);

    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toBe(
      [
        `server: ${ref('SEALUP_SERVER')}`,
        `password: ${ref('SEALUP_PASSWORD')}`,
        `hostKey: ${ref('SEALUP_HOST_KEY')}`,
        'upload: dist',
        '',
      ].join('\n'),
    );
    const env = readFileSync(join(root, 'sealup.env'), 'utf8');
    expect(parseEnv(env)).toEqual({
      SEALUP_PASSWORD: password,
      SEALUP_SERVER: server,
      SEALUP_HOST_KEY: hostKeyLine,
    });
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'sealup.env')).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\nsealup.env\n');
    expect(readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8')).toBe(
      workflow('0.0.0-source', ['SEALUP_PASSWORD', 'SEALUP_SERVER', 'SEALUP_HOST_KEY']),
    );
  });

  it('stops in a log without --server: the flag to pass, exit 2, nothing written', async () => {
    const root = newProject(files);
    const run = await runMain(['init'], { cwd: root });
    expect(run.stderr).toBe(goldenText([versionLine('init'), ...ci(false)], { color: false }));
    expect(run.exitCode).toBe(2);
    expect(() => statSync(join(root, 'sealup.yml'))).toThrow();
    expect(() => statSync(join(root, '.github'))).toThrow();
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  it("prints GitHub's form with the --from line when a .deployment.json is there", async () => {
    const root = newProject({ ...files, '.deployment.json': '{}' });
    const run = await runMain(['init'], { cwd: root, env: inGitHub });
    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('init'),
          ...ci(true),
          '::error title=Server address needed::sealup init needs --server (or --from) when there is no terminal to ask in. Nothing was written.',
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(2);
    expect(run.summary).toBe('');
  });

  it('gives --json: command init and the files written', async () => {
    const root = newProject(files);
    const run = await runMain(['init', '--json'], {
      cwd: root,
      tty: true,
      keys,
      scan: createMemoryServer().scanHostKey,
    });
    expectFrozenJson('sealup init (S02)', run.stdout, 'json-init.golden');
    expect(run.exitCode).toBe(0);
  });
});
