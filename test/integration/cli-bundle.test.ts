// Smoke tests on the built bundle (spec #1, seam 2): the one file users run works on its own,
// from a folder with no node_modules, under the leak-test harness (canaries in its environment):
// --version, --help, and a dry run against the in-process SFTP server over the real transport;
// a file written from a secret whose bytes never touch the local disk (R17).

import { exec } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from '../../scripts/build.ts';
import { repoRoot } from '../../scripts/gates.ts';
import {
  canaries,
  createSftpServer,
  expectNoLeaks,
  readTree,
  type SftpServer,
  splitMasks,
  userKey,
} from '../../src/testkit/index.ts';
import { runCli, runWithCanaries, startCli } from '../cli-kit.ts';
import { createProject, hostKeyLine, newProject, ref } from '../deploy-kit.ts';
import { silentServer } from '../sftp-kit.ts';

/**
 * The version in the package.json beside the bundles: not the repo's, so every run that says it
 * proves it was read there at start-up (spec #41 decision 34).
 */
const packageVersion = '9.8.7-beside';

describe('the cli bundle', () => {
  let root = '';
  let outdir = '';

  // The package's layout, built once for the whole file: the bundles in dist/, beside them the
  // package.json they read their version from, and the files npm packs and the action needs.
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'sealup-bundle-'));
    outdir = join(root, 'dist');
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as object;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ ...manifest, version: packageVersion }, null, 2),
    );
    for (const file of ['LICENSE', 'schema.json', 'action.yml']) {
      cpSync(join(repoRoot, file), join(root, file));
    }
    await build({ outdir });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('prints the package version for --version, from a folder with no node_modules', async () => {
    const run = await runCli([join(outdir, 'cli.mjs'), '--version'], { cwd: outdir });
    expect(run).toEqual({ exitCode: 0, stdout: `${packageVersion}\n`, stderr: '' });
  });

  it('prints the help on stdout for --help', async () => {
    const run = await runCli([join(outdir, 'cli.mjs'), '--help'], { cwd: outdir });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^Deploy your build to shared hosting over SFTP, SSH or FTP\.\n/);
    expect(run.stdout).toContain('  -n, --dry-run           Show every change, change nothing\n');
    expect(run.stderr).toBe('');
  });

  describe('a dry run against the in-process SFTP server', () => {
    let server: SftpServer;
    let project = '';
    beforeAll(async () => {
      // The canary password is the one the server takes: the login really sends it.
      const password = canaries.SEALUP_CANARY_PASSWORD ?? '';
      server = await createSftpServer({ loginFolder: '/home/deploy', password });
      project = mkdtempSync(join(tmpdir(), 'sealup bundle project '));
      mkdirSync(join(project, 'public_html', 'assets'), { recursive: true });
      writeFileSync(join(project, 'public_html', 'index.html'), '<h1>home</h1>');
      writeFileSync(join(project, 'public_html', 'assets', 'app.js'), 'console.log(1);');
      writeFileSync(
        join(project, 'sealup.yml'),
        [
          'upload: public_html',
          'targets:',
          '  production:',
          `    server: sftp://${server.user}@${server.host}:${server.port}/~/site`,
          `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `    hostKey: ${server.hostKeyLine}`,
          '',
        ].join('\n'),
      );
    });
    afterAll(async () => {
      await server.stop();
      rmSync(project, { recursive: true, force: true });
    });

    it('connects, shows every change, changes nothing, and prints the JSON object', async () => {
      const before = server.files();
      const run = await runCli([join(outdir, 'cli.mjs'), 'deploy', '-n', '--json'], {
        cwd: project,
      });

      expect(run.exitCode).toBe(0);
      expect(run.stderr.split('\n').slice(0, 2)).toEqual([
        `sealup ${packageVersion} · deploy`,
        '  DRY RUN  nothing will change on production',
      ]);
      expect(run.stderr).toContain('  host key    ');
      expect(run.stderr).toContain('    + assets/app.js ');
      expect(run.stderr).toContain('    + index.html ');
      expect(run.stderr).toContain(
        '  DRY RUN  nothing was changed. To apply: sealup deploy production\n',
      );
      expect(JSON.parse(run.stdout)).toMatchObject({
        version: packageVersion,
        target: 'production',
        dryRun: true,
        status: 'ok',
        exitCode: 0,
        uploaded: 2,
        ops: [
          { op: 'upload', path: 'assets/app.js', reason: 'new', size: 15 },
          { op: 'upload', path: 'index.html', reason: 'new', size: 13 },
        ],
      });
      expect(server.files()).toEqual(before);
    });
  });

  it('ships its licence file next to it', () => {
    const text = readFileSync(join(outdir, 'THIRD_PARTY_LICENSES.txt'), 'utf8');
    expect(text).toMatch(/^sealup bundles/);
  });

  // ssh2 is loaded on the first connect, not at start (so --version stays fast): this proves the
  // lazy load works inside the bundle, end to end over SFTP.
  it('deploys over SFTP: ssh2, loaded on first connect, works in the bundle', async () => {
    const server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    try {
      const project = createProject(
        [
          'upload: public_html',
          `server: sftp://${server.user}@${server.host}:${server.port}/~/site`,
          `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `hostKey: ${server.hostKeyLine}`,
          '',
        ].join('\n'),
        { 'public_html/index.html': '<h1>home</h1>' },
      );
      const run = await runCli([join(outdir, 'cli.mjs'), 'deploy'], { cwd: project.root });
      expect(run.stderr).toContain('Sealed up and delivered: 1 file');
      expect(run.exitCode).toBe(0);
      expect([...server.files().keys()]).toContain(`${server.loginFolder}/site/index.html`);
    } finally {
      await server.stop();
    }
  });

  // Spike 05's savings (spec #41 decision 19): ssh2 is bundled from its client alone, yaml from
  // its ESM build. What the bundle holds, then that each still works in it.
  it("holds ssh2's client without its server, and yaml's ESM build", () => {
    const meta = JSON.parse(readFileSync(join(outdir, 'meta.json'), 'utf8')) as {
      inputs: Record<string, unknown>;
    };
    const inputs = Object.keys(meta.inputs).map((path) => path.replaceAll('\\', '/'));
    expect(inputs).toContain('node_modules/ssh2/lib/client.js');
    expect(inputs).toContain('node_modules/ssh2/lib/protocol/keyParser.js');
    expect(
      inputs.filter((path) => /ssh2\/lib\/(server|keygen|http-agents)\.js$/.test(path)),
    ).toEqual([]);
    expect(inputs.some((path) => path.startsWith('node_modules/yaml/browser/'))).toBe(true);
    expect(inputs.some((path) => path.startsWith('node_modules/yaml/dist/'))).toBe(false);
  });

  it("logs in with an encrypted private key: ssh2's key parser works in the bundle", async () => {
    const key = userKey({ passphrase: 'correct horse battery' });
    const server = await createSftpServer({ authorizedKeys: [key.publicLine] });
    try {
      const project = createProject(
        [
          'upload: public_html',
          `server: sftp://${server.user}@${server.host}:${server.port}/~/site`,
          `privateKey: ${ref('DEPLOY_KEY')}`,
          `passphrase: ${ref('KEY_PASSPHRASE')}`,
          `hostKey: ${server.hostKeyLine}`,
          '',
        ].join('\n'),
        { 'public_html/index.html': '<h1>home</h1>' },
      );
      const run = await runCli([join(outdir, 'cli.mjs'), 'deploy'], {
        cwd: project.root,
        env: { DEPLOY_KEY: key.private, KEY_PASSPHRASE: 'correct horse battery' },
      });
      expect(run.exitCode, run.stderr).toBe(0);
      expect([...server.files().keys()]).toContain(`${server.loginFolder}/site/index.html`);
    } finally {
      await server.stop();
    }
  });

  // Spec #41 decision 25: the real process's environment names the cache folder.
  it('keeps its hash cache in the cache folder its environment names', async () => {
    const server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    const cache = mkdtempSync(join(tmpdir(), 'sealup bundle cache '));
    try {
      const project = createProject(
        [
          'upload: public_html',
          `server: sftp://${server.user}@${server.host}:${server.port}/~/site`,
          `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `hostKey: ${server.hostKeyLine}`,
          '',
        ].join('\n'),
        { 'public_html/index.html': '<h1>home</h1>' },
      );
      const run = await runCli([join(outdir, 'cli.mjs'), 'deploy'], {
        cwd: project.root,
        env: { LOCALAPPDATA: cache, XDG_CACHE_HOME: cache },
      });
      expect(run.exitCode).toBe(0);
      expect(readdirSync(join(cache, 'sealup'))).toEqual([
        expect.stringMatching(/^[0-9a-f]{16}\.json$/),
      ]);
    } finally {
      await server.stop();
      rmSync(cache, { recursive: true, force: true });
    }
  });

  // R17: a file written from a secret is built in memory. The child's temp folders point at an
  // empty folder of the test's, so nothing it might write there escapes the search.
  it('writes a file from a multi-line secret without its bytes touching the local disk', async () => {
    const server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    const scratch = mkdtempSync(join(tmpdir(), 'sealup bundle temp '));
    try {
      const project = createProject(
        [
          'upload: public_html',
          `server: sftp://${server.user}@${server.host}:${server.port}/~/site`,
          `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `hostKey: ${server.hostKeyLine}`,
          'write:',
          `  api/.env: ${ref('SEALUP_CANARY_MULTILINE')}`,
          '',
        ].join('\n'),
        { 'public_html/index.html': '<h1>home</h1>' },
      );
      const temp = { TMPDIR: scratch, TMP: scratch, TEMP: scratch };

      const run = await runCli([join(outdir, 'cli.mjs'), 'deploy'], {
        cwd: project.root,
        env: temp,
      });

      expect(run.exitCode, run.stderr).toBe(0);
      const site = `${server.loginFolder}/site`;
      const secret = server.files().get(`${site}/api/.env`);
      expect(new TextDecoder().decode(secret?.bytes)).toBe(canaries.SEALUP_CANARY_MULTILINE);
      expect(secret?.mode).toBe(0o600);
      const { [`${site}/api/.env`]: _, ...others } = Object.fromEntries(
        [...server.files()].map(([path, file]) => [path, file.bytes]),
      );
      expectNoLeaks({ ...others, ...(await readTree(project.root)), ...(await readTree(scratch)) });
    } finally {
      await server.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // Windows cannot send SIGINT to a child process (kill() ends it at once), so this runs on the
  // Linux CI legs; the signal's effect on a run is tested through main() on every OS.
  it.runIf(process.platform !== 'win32')(
    'turns Ctrl-C (SIGINT) into the run signal: exit 130, nothing changed',
    async () => {
      const silent = await silentServer();
      try {
        const project = createProject(
          [
            'upload: public_html',
            `server: sftp://deploy@${silent.host}:${silent.port}/~/site`,
            `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
            `hostKey: ${hostKeyLine}`,
            '',
          ].join('\n'),
          { 'public_html/index.html': '<h1>home</h1>' },
        );
        const started = startCli([join(outdir, 'cli.mjs'), 'deploy'], { cwd: project.root });
        // The target block is out: the run is waiting on the handshake.
        while (!started.stderrSoFar().includes('sftp://')) await sleep(20);
        started.child.kill('SIGINT');
        const run = await started.done;
        expect(run.exitCode).toBe(130);
        expect(run.stderr).toContain('More: sealup.dev/e/interrupted');
      } finally {
        await silent.stop();
      }
    },
  );

  // The action's bundle (spec #24 decisions 33-35): the same build, its own entry. Run as the
  // runner runs it (`node dist/action.mjs`, inputs as INPUT_* variables), over the real transport.
  it('builds the action bundle, which runs a dry run as a runner step, with its outputs', async () => {
    const server = await createSftpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    const runner = mkdtempSync(join(tmpdir(), 'sealup bundle runner '));
    try {
      const project = createProject(
        [
          'upload: public_html',
          `server: sftp://${server.user}@${server.host}:${server.port}/~/site`,
          `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
          `hostKey: ${server.hostKeyLine}`,
          '',
        ].join('\n'),
        { 'public_html/index.html': '<h1>home</h1>' },
      );
      const output = join(runner, 'output');
      const summary = join(runner, 'summary');
      writeFileSync(output, '');
      writeFileSync(summary, '');

      const run = await runWithCanaries([join(outdir, 'action.mjs')], {
        cwd: project.root,
        env: {
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKSPACE: project.root,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          RUNNER_TEMP: runner,
          INPUT_TARGET: '',
          INPUT_CONFIG: '',
          'INPUT_DRY-RUN': 'true',
          'INPUT_WORKING-DIRECTORY': '.',
        },
      });

      expect(run.exitCode, run.stderr).toBe(0);
      const { masks, rest } = splitMasks(run.stderr);
      expect(masks).toContain('::add-mask::');
      expect(rest.split('\n')[0]).toBe(`sealup ${packageVersion} · deploy`);
      const outputs = readFileSync(output, 'utf8');
      expect(outputs).toMatch(/^status<<(ghadelimiter_[\w-]+)\ndry-run\n\1\n/);
      const plan = /^plan<<(\S+)\n(.+)\n\1$/m.exec(outputs)?.[2] ?? '';
      expect(JSON.parse(readFileSync(plan, 'utf8'))).toMatchObject({ dryRun: true, uploaded: 1 });
      expect(readFileSync(summary, 'utf8')).toMatch(/^### 📋 /);
      expectNoLeaks({
        stdout: run.stdout,
        stderr: rest,
        outputs,
        plan: readFileSync(plan, 'utf8'),
        summary: readFileSync(summary, 'utf8'),
      });
    } finally {
      await server.stop();
      rmSync(runner, { recursive: true, force: true });
    }
  });

  it("ends the action bundle with its bundled code's licences, as it is committed alone", () => {
    const text = readFileSync(join(outdir, 'action.mjs'), 'utf8');
    const footer = text.slice(text.lastIndexOf('\n/*\n'));
    expect(footer).toMatch(/^\n\/\*\nsealup bundles the following third-party code\./);
    expect(footer).toContain('\nssh2@');
    expect(footer.endsWith('*/\n')).toBe(true);
    expect(footer.slice(4, -3)).not.toContain('*/');
  });

  // Spec #41 decision 34: the bundles carry no version. The CLI and the action read it from the
  // package.json beside their bundle at start-up, so a release PR that bumps it changes no
  // committed bundle. Proven on the two layouts users run: the npm tarball, unpacked as npm
  // installs it, and the action's checkout (action.yml, package.json, dist/action.mjs).
  it('says the version from the packed tarball: --version', async () => {
    const tarball = await npmPack(root);
    const installed = join(root, 'installed');
    unpackTarball(join(root, tarball), installed);
    const cli = join(installed, 'package', 'dist', 'cli.mjs');
    const run = await runCli([cli, '--version'], { cwd: installed });
    expect(run).toEqual({ exitCode: 0, stdout: `${packageVersion}\n`, stderr: '' });
  });

  it("says the version from the action's checkout: the log's first line", async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sealup beside workspace '));
    try {
      const run = await runCli([join(outdir, 'action.mjs')], {
        cwd: workspace,
        env: {
          GITHUB_WORKSPACE: workspace,
          INPUT_TARGET: '',
          INPUT_CONFIG: '',
          'INPUT_DRY-RUN': 'false',
          'INPUT_WORKING-DIRECTORY': '.',
        },
      });
      expect(run.stderr.split('\n')[0]).toBe(`sealup ${packageVersion} · deploy`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("pins init's workflow to the tag, with a comment saying to pin: no release SHA in this build", async () => {
    expect(await initWorkflow(join(outdir, 'cli.mjs'))).toContain(
      `      # Pin this step to v${packageVersion}'s full commit SHA (on its release page), as the\n` +
        '      # steps above are: a tag can move, a commit cannot.\n' +
        `      - uses: sealup/sealup@v${packageVersion}\n`,
    );
  });
});

// ssh2 is CommonJS: at load time it calls `require` on Node built-ins and reads `__dirname`.
// Without the build's shims an ESM bundle of it dies at start. This fixture library does both.
describe('a bundled CommonJS library', () => {
  let folder = '';

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'sealup-cjs-'));
    const lib = join(folder, 'node_modules', 'cjs-lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(lib, 'package.json'),
      JSON.stringify({ name: 'cjs-lib', version: '1.2.3', license: 'MIT', main: 'index.js' }),
    );
    writeFileSync(join(lib, 'LICENSE'), 'MIT licence of cjs-lib\n');
    writeFileSync(
      join(lib, 'index.js'),
      [
        "const name = 'cry' + 'pto';",
        'const { createHash } = require(name);',
        "const path = require('path');",
        "exports.folder = path.basename(path.dirname(__filename)) + ' ' + path.basename(__dirname);",
        "exports.hash = createHash('sha256').update('x').digest('hex').slice(0, 8);",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(folder, 'entry.mjs'),
      "import lib from 'cjs-lib';\nconsole.log(lib.folder, lib.hash);\n",
    );
    await build({ outdir: join(folder, 'out'), entry: join(folder, 'entry.mjs') });
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('runs: `require`, `__filename` and `__dirname` work inside the ESM bundle', async () => {
    const run = await runCli([join(folder, 'out', 'cli.mjs')], { cwd: folder });
    expect(run).toEqual({ exitCode: 0, stdout: 'out out 2d711642\n', stderr: '' });
  });

  it('lists the library in the licence file', () => {
    const text = readFileSync(join(folder, 'out', 'THIRD_PARTY_LICENSES.txt'), 'utf8');
    expect(text).toContain('cjs-lib@1.2.3 (MIT)\n\nMIT licence of cjs-lib');
  });
});

// Spec #41 decision 38: the public release build puts the release commit's SHA into the CLI
// bundle, and init pins the workflow's sealup step to it. The CLI bundle alone is built (its
// entry named): the action's bundle never takes the SHA (check-dist.test.ts proves it).
describe('a release build', () => {
  const releaseSha = '0123456789abcdef0123456789abcdef01234567';
  let root = '';

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'sealup-release-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
    const entry = join(repoRoot, 'src', 'cli', 'bin.ts');
    await build({ outdir: join(root, 'dist'), entry, releaseSha });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("pins init's workflow to the release commit, the tag in a comment", async () => {
    const text = await initWorkflow(join(root, 'dist', 'cli.mjs'));
    expect(text).toContain(`      - uses: sealup/sealup@${releaseSha} # v${packageVersion}\n`);
    expect(text).not.toContain('Pin this step');
  });

  it('refuses a release SHA that is not a full commit SHA, building nothing', async () => {
    const outdir = join(root, 'refused');
    await expect(build({ outdir, releaseSha: 'v1.2.3' })).rejects.toThrow(
      '--release-sha must be a full commit SHA (40 hex digits), not "v1.2.3"',
    );
    expect(() => readFileSync(join(outdir, 'cli.mjs'))).toThrow();
  });
});

/** The workflow `<bundle> init --server …` writes in a new project, without a terminal. */
async function initWorkflow(bundle: string): Promise<string> {
  const project = newProject({ 'dist/index.html': '<h1>home</h1>' });
  const run = await runCli([bundle, 'init', '--server', 'sftp://deploy@ssh.example.com/www'], {
    cwd: project,
  });
  expect(run.exitCode, run.stderr).toBe(0);
  return readFileSync(join(project, '.github', 'workflows', 'deploy.yml'), 'utf8');
}

/** `npm pack` in `folder`, the tarball written in it; gives the tarball's file name. */
function npmPack(folder: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // npm is a .cmd file on Windows: only a shell runs it. The command is fixed text. Packing
    // needs no network, and the update check would only slow it down.
    exec(
      'npm pack --json --ignore-scripts --offline --no-update-notifier --pack-destination .',
      { cwd: folder },
      (error, out) => {
        if (error !== null) return reject(error);
        const [packed] = JSON.parse(out) as { filename: string }[];
        if (packed === undefined) return reject(new Error(`npm pack gave no tarball: ${out}`));
        resolve(packed.filename);
      },
    );
  });
}

/** Unpacks a .tgz (ustar, as npm writes it) into `folder`: its files only. */
function unpackTarball(tarball: string, folder: string): void {
  const tar = gunzipSync(readFileSync(tarball));
  const text = (from: number, to: number): string =>
    tar.toString('utf8', from, to).replace(/\0[\s\S]*$/, '');
  let at = 0;
  while (at + 512 <= tar.length && text(at, at + 100) !== '') {
    const name = text(at, at + 100);
    const prefix = text(at + 345, at + 500);
    const size = Number.parseInt(text(at + 124, at + 136).trim(), 8);
    const type = text(at + 156, at + 157);
    at += 512;
    if (type === '0' || type === '') {
      const file = join(folder, ...(prefix === '' ? name : `${prefix}/${name}`).split('/'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, tar.subarray(at, at + size));
    }
    at += Math.ceil(size / 512) * 512;
  }
}
