// The action's self-test (spec #24 decision 36; 0014), the steps around `uses: ./` in
// .github/workflows/self-test.yml. Each step is one subcommand:
//
//   node scripts/self-test.ts canaries        makes the canary secrets: a password and a
//                                             two-line `write` secret, masked first, then put in
//                                             GITHUB_ENV (no repository secret)
//   node scripts/self-test.ts docker-server   builds and starts the e2e OpenSSH image (Linux)
//   node scripts/self-test.ts server          runs the in-process SFTP server until killed
//                                             (Windows, macOS; started in the background)
//   node scripts/self-test.ts wait-server     waits until the server has written its facts
//   node scripts/self-test.ts project         writes the project the action deploys, inside
//                                             the workspace: one single file and one write entry
//   node scripts/self-test.ts check           checks the three action steps' outputs (env DRY,
//                                             DEPLOY, AGAIN: toJSON of each step's outputs), the
//                                             plan file, a job summary, the server's tree read
//                                             over SFTP, and that no canary leaked
//
// A job summary file is only readable by its own step (the runner removes a step's file-command
// files when the next step starts), so `check` runs the committed bundle once more as the runner
// runs it (`node dist/action.mjs`, inputs as INPUT_* variables), a dry run with its own summary
// and outputs files, and checks those.
//
// The server's facts (host, port, user, host key) go to `$RUNNER_TEMP/sealup-self-test.json`.
// Nothing here prints a secret: a failure names what differs, never a value.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as dial } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { createSftpServer, findLeaks } from '../src/testkit/index.ts';
import { repoRoot } from './gates.ts';

interface ServerFacts {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** `ssh-ed25519 <base64>`. */
  readonly hostKeyLine: string;
}

/** The project's one target and its folder, relative to the login folder. */
const target = 'selftest';
const siteFolder = 'site';
/** The project folder, relative to the workspace (the workflow's `working-directory`). */
const projectFolder = 'selftest-project';
const indexHtml = '<h1>sealup self-test</h1>\n';
/** `${NAME}`, a variable reference in sealup.yml. */
const ref = (name: string): string => `$\{${name}}`;

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const factsFile = (): string => join(need('RUNNER_TEMP'), 'sealup-self-test.json');

/** GitHub's escaping of a workflow command's data (as the toolkit's escapeData). */
const escapeData = (text: string): string =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

function canaries(): void {
  // Hex only: chpasswd reads `user:password`, and the values travel through GITHUB_ENV.
  const hex = (): string => randomBytes(12).toString('hex');
  const password = `Cn4ry-pw-${hex()}`;
  const appEnv = `APP_KEY=Cn4ry-key-${hex()}\nDB_PASSWORD=Cn4ry-db-${hex()}`;
  // Masked before anything else is written, each line too (as the toolkit's setSecret).
  for (const value of [password, appEnv, ...appEnv.split('\n')]) {
    process.stdout.write(`::add-mask::${escapeData(value)}\n`);
  }
  const lines = [`SELFTEST_PASSWORD=${password}`];
  const delimiter = `ghadelimiter_${randomUUID()}`;
  lines.push(`SELFTEST_APP_ENV<<${delimiter}`, appEnv, delimiter);
  appendFileSync(need('GITHUB_ENV'), `${lines.join('\n')}\n`);
  console.log('canary secrets made: SELFTEST_PASSWORD, SELFTEST_APP_ENV (two lines)');
}

/** Runs `docker <args>` with `input` on stdin; throws on a non-zero exit. */
function docker(args: readonly string[], input?: string): string {
  const run = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 300_000 });
  if (run.status !== 0) throw new Error(`docker ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

async function dockerServer(): Promise<void> {
  const image = 'sealup-self-test-openssh';
  docker(['build', '--quiet', '--tag', image, join(repoRoot, 'test', 'e2e', 'openssh')]);
  const id = docker(['run', '--detach', '--rm', '--publish', '127.0.0.1::22', image]).trim();
  // The password goes on chpasswd's stdin, never in an argument list.
  docker(['exec', '--interactive', id, 'chpasswd'], `deploy:${need('SELFTEST_PASSWORD')}\n`);
  const published = docker(['port', id, '22/tcp']).trim().split('\n')[0] ?? '';
  const port = Number(published.slice(published.lastIndexOf(':') + 1));
  await waitForBanner('127.0.0.1', port);
  const [type = '', key = ''] = docker(['exec', id, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])
    .trim()
    .split(' ');
  writeFacts({ host: '127.0.0.1', port, user: 'deploy', hostKeyLine: `${type} ${key}` });
}

async function inProcessServer(): Promise<void> {
  const server = await createSftpServer({
    loginFolder: '/home/deploy',
    password: need('SELFTEST_PASSWORD'),
  });
  writeFacts({
    host: server.host,
    port: server.port,
    user: server.user,
    hostKeyLine: server.hostKeyLine,
  });
  // Runs until the job ends: the runner stops what a step left running.
  await new Promise(() => undefined);
}

function writeFacts(facts: ServerFacts): void {
  writeFileSync(factsFile(), JSON.stringify(facts));
  console.log(`server ready on ${facts.host}:${facts.port}`);
}

const readFacts = (): ServerFacts => JSON.parse(readFileSync(factsFile(), 'utf8')) as ServerFacts;

async function waitServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!existsSync(factsFile())) {
    if (Date.now() > deadline) throw new Error('the server did not start within 60 s');
    await sleep(200);
  }
  const facts = readFacts();
  await waitForBanner(facts.host, facts.port);
  console.log(`server answers on ${facts.host}:${facts.port}`);
}

/** Waits until the server sends its `SSH-` banner. */
async function waitForBanner(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = dial({ host, port });
      const done = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(2_000, () => done(false));
      socket.once('data', (data) => done(data.toString('latin1').startsWith('SSH-')));
      socket.once('error', () => done(false));
      socket.once('close', () => done(false));
    });
    if (ready) return;
    await sleep(200);
  }
  throw new Error(`no SSH banner from ${host}:${port} within 30 s`);
}

function project(): void {
  const facts = readFacts();
  const root = join(need('GITHUB_WORKSPACE'), projectFolder);
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build', 'index.html'), indexHtml);
  writeFileSync(
    join(root, 'sealup.yml'),
    [
      '# Written by scripts/self-test.ts for the action self-test.',
      'upload:',
      '  build/index.html: index.html',
      'write:',
      `  api/.env: ${ref('SELFTEST_APP_ENV')}`,
      'targets:',
      `  ${target}:`,
      `    server: sftp://${facts.user}@${facts.host}:${facts.port}/~/${siteFolder}`,
      `    password: ${ref('SELFTEST_PASSWORD')}`,
      `    hostKey: ${facts.hostKeyLine}`,
      '    url: https://example.com',
      '',
    ].join('\n'),
  );
  console.log(`project written to ${projectFolder}/`);
}

interface ServerFile {
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

/** Every file under the site folder, read over SFTP with the pinned host key checked. */
function serverTree(facts: ServerFacts): Promise<Map<string, ServerFile>> {
  const key = Buffer.from(facts.hostKeyLine.split(' ')[1] ?? '', 'base64');
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    client.on('error', reject);
    client.on('ready', () => {
      client.sftp(async (error, sftp) => {
        if (error) return reject(error);
        try {
          const tree = new Map<string, ServerFile>();
          const walk = async (folder: string, prefix: string): Promise<void> => {
            const entries = await new Promise<ssh2.FileEntryWithStats[]>((done, fail) =>
              sftp.readdir(folder, (e, list) => (e ? fail(e) : done(list))),
            );
            for (const entry of entries.sort((a, b) => (a.filename < b.filename ? -1 : 1))) {
              const path = `${folder}/${entry.filename}`;
              const name = `${prefix}${entry.filename}`;
              if (entry.attrs.isDirectory()) await walk(path, `${name}/`);
              else {
                const bytes = await new Promise<Buffer>((done, fail) =>
                  sftp.readFile(path, (e, data) => (e ? fail(e) : done(data))),
                );
                tree.set(name, {
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                  size: bytes.length,
                  mode: entry.attrs.mode & 0o777,
                });
              }
            }
          };
          const login = await new Promise<string>((done, fail) =>
            sftp.realpath('.', (e, path) => (e ? fail(e) : done(path))),
          );
          await walk(`${login}/${siteFolder}`, '');
          resolve(tree);
        } catch (failure) {
          reject(failure);
        } finally {
          client.end();
        }
      });
    });
    client.connect({
      host: facts.host,
      port: facts.port,
      username: facts.user,
      password: need('SELFTEST_PASSWORD'),
      hostVerifier: (offered: Buffer) => offered.equals(key),
    });
  });
}

/** Runs the committed bundle as the runner does, with its own summary and outputs files. */
function bundleRun(): Promise<{ exitCode: number; summary: string; outputs: string }> {
  const temp = join(need('RUNNER_TEMP'), `sealup-self-test-${randomUUID()}`);
  mkdirSync(temp);
  const summary = join(temp, 'step_summary');
  const outputs = join(temp, 'output');
  writeFileSync(summary, '');
  writeFileSync(outputs, '');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'action.mjs')], {
      cwd: need('GITHUB_WORKSPACE'),
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: outputs,
        INPUT_TARGET: target,
        INPUT_CONFIG: '',
        'INPUT_DRY-RUN': 'true',
        'INPUT_WORKING-DIRECTORY': projectFolder,
      },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        exitCode: code ?? -1,
        summary: readFileSync(summary, 'utf8'),
        outputs: readFileSync(outputs, 'utf8'),
      }),
    );
  });
}

async function check(): Promise<void> {
  const problems: string[] = [];
  const expect = (what: string, ok: boolean): void => {
    if (!ok) problems.push(what);
  };
  const outputsOf = (name: string): Record<string, string> =>
    JSON.parse(need(name)) as Record<string, string>;
  const dry = outputsOf('DRY');
  const deploy = outputsOf('DEPLOY');
  const again = outputsOf('AGAIN');
  const bytes = String(Buffer.byteLength(indexHtml));

  // The dry run: the plan, nothing changed yet (the deploy after it uploaded the file).
  expect('dry run: status is dry-run', dry.status === 'dry-run');
  expect('dry run: uploaded is 1 (would be)', dry.uploaded === '1');
  expect('dry run: plan names a file', (dry.plan ?? '') !== '' && existsSync(dry.plan ?? ''));
  const plan = dry.plan !== undefined && existsSync(dry.plan) ? readFileSync(dry.plan, 'utf8') : '';
  const planObject = plan === '' ? {} : (JSON.parse(plan) as { dryRun?: unknown; ops?: unknown });
  expect('plan file: a dry run', planObject.dryRun === true);
  expect(
    'plan file: one upload and one write',
    JSON.stringify(planObject.ops) ===
      JSON.stringify([
        { op: 'upload', path: 'index.html', reason: 'new', size: Number(bytes) },
        { op: 'write', path: 'api/.env', reason: 'new', size: null },
      ]),
  );

  // The deploy, then the redeploy.
  expect('deploy: status is deployed', deploy.status === 'deployed');
  expect('deploy: url', deploy.url === 'https://example.com');
  expect('deploy: uploaded is 1', deploy.uploaded === '1');
  expect('deploy: deleted is 0', deploy.deleted === '0');
  expect('deploy: bytes', deploy.bytes === bytes);
  expect('deploy: duration in seconds, one decimal', /^\d+\.\d$/.test(deploy.duration ?? ''));
  expect('deploy: no plan', deploy.plan === '');
  expect('redeploy: status is unchanged', again.status === 'unchanged');
  expect('redeploy: uploaded is 0', again.uploaded === '0');
  expect('redeploy: unchanged is 2', again.unchanged === '2');

  // A job summary, from the committed bundle run as the runner runs it.
  const run = await bundleRun();
  expect('bundle run: exit code 0', run.exitCode === 0);
  expect('summary: a dry run heading', run.summary.startsWith('### 📋 '));
  expect('summary: the target table', run.summary.includes('| Target | `sftp://'));
  expect(
    'summary: the host key verified',
    /\| Host key \| ED25519 `SHA256:[^`]+` verified \|/.test(run.summary),
  );
  expect(
    'bundle run: status dry-run in its outputs',
    /^status<<(\S+)\ndry-run\n\1$/m.test(run.outputs),
  );

  // The server's tree: the single file and the file written from the secret, owner-only.
  const tree = await serverTree(readFacts());
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  expect(
    'server: exactly index.html and api/.env',
    [...tree.keys()].join(' ') === 'api/.env index.html',
  );
  expect('server: index.html is the build file', tree.get('index.html')?.sha256 === sha(indexHtml));
  expect(
    'server: api/.env holds the secret',
    tree.get('api/.env')?.sha256 === sha(need('SELFTEST_APP_ENV')),
  );
  expect('server: api/.env is 0600', tree.get('api/.env')?.mode === 0o600);

  // No canary in what the steps left: outputs, plan file, summary.
  const leaks = findLeaks(
    {
      'dry run outputs': JSON.stringify(dry),
      'deploy outputs': JSON.stringify(deploy),
      'redeploy outputs': JSON.stringify(again),
      'plan file': plan,
      'job summary': run.summary,
      'bundle run outputs': run.outputs,
    },
    { SELFTEST_PASSWORD: need('SELFTEST_PASSWORD'), SELFTEST_APP_ENV: need('SELFTEST_APP_ENV') },
  );
  for (const leak of leaks) problems.push(`${leak.canary} leaked in ${leak.place} as ${leak.form}`);

  for (const problem of problems) console.log(`::error title=Self-test::${problem}`);
  console.log(
    problems.length === 0 ? 'self-test: every check holds' : `self-test: ${problems.length} failed`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
}

const commands: Readonly<Record<string, () => void | Promise<void>>> = {
  canaries,
  'docker-server': dockerServer,
  server: inProcessServer,
  'wait-server': waitServer,
  project,
  check,
};

const command = commands[process.argv[2] ?? ''];
if (command === undefined) {
  console.error(`usage: node scripts/self-test.ts <${Object.keys(commands).join('|')}>`);
  process.exitCode = 2;
} else {
  try {
    await command();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
