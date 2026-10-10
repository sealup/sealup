// vsftpd in a container (spec #41 decisions 6, 8 and 17; seams 2 and 3). vsftpd offers no MLSD,
// so sealup reads its LIST: the Session contract suite runs that path over FTPS (TLS required,
// session reuse required, pinned to the test certificate). The built bundle deploys a project,
// redeploys it with a change, a new file and a delete, writes a file from a secret with mode 0600
// (R17) and pulls the target folder back; after each run the server's tree (paths, sizes,
// SHA-256, computed in the container) must be the local one, and no file on the server holds the
// canary password. Names a shell or a glob would read stay plain names (R15). LIST gives dates to
// the minute: the limit SECURITY.md's known limits state, pinned here.
//
// Security: R9, EPSV refused and a PASV reply naming 192.0.2.10, every connection still goes to
// the server; R8, a server without TLS answers AUTH TLS with a refusal, and `ftps://` stops there
// before the user name, while `ftp://` deploys with the plain-FTP warning.
//
// Runs where Docker runs Linux containers: always on Linux (a missing Docker fails the run), on
// other systems only when Docker answers with Linux (so Windows CI skips it).

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from '../../scripts/build.ts';
import type { ServerPath } from '../../src/contracts/index.ts';
import { canaries, expectNoLeaks, readTree } from '../../src/testkit/index.ts';
import { connect } from '../../src/transport/index.ts';
import { runCli } from '../cli-kit.ts';
import { createProject, ref, runMain } from '../deploy-kit.ts';
import {
  containerTarget,
  dialedHosts,
  type FtpContainer,
  ftpsContractOn,
  ftpsDeployConfig,
  otherAddress,
  useFtpContainer,
} from '../ftp-servers-kit.ts';
import { dockerRunsLinux, type FileFacts } from '../openssh-kit.ts';

const enabled = process.platform === 'linux' || dockerRunsLinux();

/** A site with nested folders, spaces, an empty file, large files, and names a shell would read. */
function site(): Record<string, Uint8Array> {
  const text = (value: string) => new TextEncoder().encode(value);
  const bytes = (seed: number, size: number) =>
    Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed * 7 + (i >> 8)) % 256);
  const files: Record<string, Uint8Array> = {
    'public_html/index.html': text('<h1>home</h1>\n'),
    'public_html/my pages/about us.html': text('<h1>about</h1>\n'),
    'public_html/empty.txt': new Uint8Array(),
    'public_html/assets/main.4f2a9c1e.js': bytes(1, 1_500_000),
    'public_html/assets/video.mp4': bytes(2, 3_000_000),
    'public_html/old/legacy.html': text('<p>gone soon</p>\n'),
    // R15, and vsftpd reads LIST's argument as a glob: each stays a name.
    "public_html/a'b.php": text("<?php echo 'q';\n"),
    'public_html/$(touch pwned)': text('p\n'),
    'public_html/-rf': text('r\n'),
    'public_html/[ab].txt': text('brackets\n'),
    'public_html/{a,b}.txt': text('braces\n'),
  };
  for (let i = 0; i < 60; i++) {
    files[`public_html/vendor/pkg${i % 6}/src/file${i}.php`] = bytes(i + 10, 200 + i * 97);
  }
  return files;
}

/** The paths, sizes and SHA-256 of the files under a local folder, computed here. */
async function localTree(folder: string): Promise<Map<string, FileFacts>> {
  const files = Object.entries(await readTree(folder)).sort(([a], [b]) => (a < b ? -1 : 1));
  return new Map(
    files.map(([path, bytes]) => [
      path,
      { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    ]),
  );
}

/** The folders that hold those files (each parent, without the top folder itself). */
function foldersOf(tree: ReadonlyMap<string, unknown>): string[] {
  const folders = new Set<string>();
  for (const path of tree.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return [...folders].sort();
}

/** The target folder on the server holds exactly the local build output: files and folders. */
async function expectSameTree(server: FtpContainer, local: string): Promise<void> {
  const expected = await localTree(local);
  expect(await server.tree('site')).toEqual(expected);
  expect(await server.folders('site')).toEqual(foldersOf(expected));
}

describe.runIf(enabled)('vsftpd in a container, over FTPS', () => {
  const server = useFtpContainer('vsftpd', { tls: true });
  let outdir = '';
  const cli = () => join(outdir, 'cli.mjs');

  beforeAll(async () => {
    outdir = mkdtempSync(join(tmpdir(), 'sealup-e2e-ftp-'));
    await build({ outdir });
  });
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  ftpsContractOn(server);

  it('sealup deploy, then a redeploy with a change, a new file and a delete: the server holds the local tree', async () => {
    await server().clear();
    const project = createProject(ftpsDeployConfig(server()), site());
    const output = join(project.root, 'public_html');

    const first = await runCli([cli(), 'deploy'], { cwd: project.root });
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stderr).toContain('certificate CN=sealup test FTP server  pinned');
    expect(first.stderr).not.toContain('Plain FTP');
    await expectSameTree(server(), output);

    // A change (new size), a new file in a new folder, and a delete that empties a folder.
    writeFileSync(join(output, 'index.html'), '<h1>home, version 2</h1>\n');
    writeFileSync(join(output, '-rf'), 'still a file\n');
    mkdirSync(join(output, 'api'));
    writeFileSync(join(output, 'api', 'new file.json'), '{"new":true}\n');
    rmSync(join(output, 'old'), { recursive: true });
    const redeploy = await runCli([cli(), 'deploy'], { cwd: project.root });
    expect(redeploy.exitCode, redeploy.stderr).toBe(0);
    await expectSameTree(server(), output);
    expect((await server().tree('site')).get('index.html')?.size).toBe(25);
    expect(await server().folders('site')).not.toContain('old');

    const again = await runCli([cli(), 'deploy'], { cwd: project.root });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stderr).toContain('Already up to date');

    // The manifest is alone in its own folder, outside the target folder; nothing else appeared
    // (no temp name, no file a shell made), and no file holds the canary in any form.
    expect([...(await server().tree('.sealup')).keys()]).toEqual([
      expect.stringMatching(/^[a-z0-9-]+\.json$/),
    ]);
    const everything = [...(await server().tree('.')).keys(), ...(await server().folders('.'))];
    expect(everything.filter((path) => path.includes('.sealup-'))).toEqual([]);
    expect(everything.filter((path) => path.endsWith('pwned') && !path.includes('$('))).toEqual([]);
    expectNoLeaks(await server().files('.'));
  });

  it('writes a file from a multi-line secret with mode 0600, and a redeploy leaves it alone (R17)', async () => {
    await server().clear();
    const config = ftpsDeployConfig(
      server(),
      'write:',
      `  api/.env: ${ref('SEALUP_CANARY_MULTILINE')}`,
    );
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>\n' });

    const first = await runCli([cli(), 'deploy'], { cwd: project.root });
    expect(first.exitCode, first.stderr).toBe(0);
    const secret = canaries.SEALUP_CANARY_MULTILINE;
    expect((await server().tree('site')).get('api/.env')).toEqual({
      size: Buffer.byteLength(secret),
      sha256: createHash('sha256').update(secret).digest('hex'),
    });
    const written = await server().stat('site/api/.env');
    expect(written.mode).toBe(0o600);

    const again = await runCli([cli(), 'deploy'], { cwd: project.root });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stderr).toContain('Already up to date: 2 files checked');
    expect(await server().stat('site/api/.env')).toEqual(written);

    const { 'site/api/.env': _, ...others } = await server().files('.');
    expect(Object.keys(others).some((path) => path.includes('.sealup-'))).toBe(false);
    expectNoLeaks(others);
  });

  it('sealup pull copies the target folder here, checked by SHA-256; a second pull finds it all here', async () => {
    await server().clear();
    const project = createProject(ftpsDeployConfig(server(), 'pull:', '  .: pulled'), site());
    const deployed = await runCli([cli(), 'deploy'], { cwd: project.root });
    expect(deployed.exitCode, deployed.stderr).toBe(0);

    // A pull runs only on a terminal (0023 §7): through main() in this process, as a person
    // would, with the real transport.
    const pulled = await runMain(['pull'], { cwd: project.root, tty: true, connect });
    expect(pulled.exitCode, pulled.stderr).toBe(0);
    expect(await localTree(join(project.root, 'pulled'))).toEqual(await server().tree('site'));

    const again = await runMain(['pull'], { cwd: project.root, tty: true, connect });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stderr).toMatch(/Already here:\S* 71 files checked against 127\.0\.0\.1 in /);
  });

  // SECURITY.md's known limits: vsftpd has no MLSD, and its LIST gives dates to the minute.
  it('lists dates to the minute: LIST is all vsftpd offers, and it has no seconds', async () => {
    await server().clear();
    const session = await connect(containerTarget(server()), { signal: undefined });
    try {
      const before = Math.floor(Date.now() / 1000);
      await session.put({ bytes: new TextEncoder().encode('x') }, '/a.txt' as ServerPath);
      const listed = await session.list('/' as ServerPath, 10);
      const entry = listed.kind === 'found' ? listed.entries[0] : undefined;
      expect(entry?.name).toBe('a.txt');
      expect((entry?.mtime ?? 1) % 60).toBe(0);
      expect(Math.abs((entry?.mtime ?? 0) - before)).toBeLessThan(120);
    } finally {
      await session.close();
    }
  });
});

describe.runIf(enabled)('vsftpd naming another address in its PASV reply (R9)', () => {
  const server = useFtpContainer('vsftpd', { tls: true, noEpsv: true, pasvAddress: otherAddress });

  it('deploys over FTPS, every connection to the server it named, none to the other address', async () => {
    const project = createProject(ftpsDeployConfig(server()), {
      'public_html/index.html': '<h1>home</h1>\n',
      'public_html/assets/app.js': 'console.log(1);\n',
    });

    const { run, hosts } = await dialedHosts(() =>
      runMain(['deploy'], { cwd: project.root, connect }),
    );

    expect(run.exitCode, run.stderr).toBe(0);
    expect([...(await server().tree('site')).keys()]).toEqual(['assets/app.js', 'index.html']);
    expect(new Set(hosts)).toEqual(new Set([server().host]));
    const log = await server().log();
    expect(log).toMatch(
      /FTP command: Client "[^"]+", "EPSV"\n.*FTP response: Client "[^"]+", "5\d\d /,
    );
    expect(log).toContain('"227 Entering Passive Mode (192,0,2,10,');
  });
});

describe.runIf(enabled)('vsftpd without TLS (R8, S23)', () => {
  const server = useFtpContainer('vsftpd', { tls: false });

  it('ftps:// stops at the refused AUTH TLS with exit 4, before the user name', async () => {
    const plain = server();
    const project = createProject(
      [
        `server: ftps://deploy@${plain.host}:${plain.port}/~/site`,
        `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
        'upload: public_html',
        '',
      ].join('\n'),
      { 'public_html/index.html': '<h1>home</h1>\n' },
    );

    const run = await runMain(['deploy'], { cwd: project.root, connect });

    expect(run.exitCode, run.stderr).toBe(4);
    expect(run.stderr).toContain('sealup.dev/e/tls-refused');
    const log = await plain.log();
    expect(log).toContain('"AUTH TLS"');
    expect(log).not.toMatch(/FTP command: Client "[^"]+", "(USER|PASS)\b/);
    expect(await plain.folders('.')).toEqual([]);
  });

  it('ftp:// deploys with the plain-FTP warning', async () => {
    const plain = server();
    await plain.clear();
    const project = createProject(ftpsDeployConfig(plain), {
      'public_html/index.html': '<h1>home</h1>\n',
      'public_html/my pages/about us.html': '<h1>about</h1>\n',
    });

    const run = await runMain(['deploy'], { cwd: project.root, connect });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain('Plain FTP: your password and files travel unencrypted.');
    expect([...(await plain.tree('site')).keys()]).toEqual([
      'index.html',
      'my pages/about us.html',
    ]);
  });
});
