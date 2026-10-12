// `sealup pull` through main() (spec #24 decision 25, owner ruling 7, R10, R19, R21): what
// arrives here, what stays, what stops the pull before any local write, and the words. Runs on a
// terminal (stdin and stderr), the only place a pull runs; against the memory server unless it
// says SFTP. Every run is under the leak test (runMain).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canaries,
  createMemoryServer,
  expectNoLeaks,
  goldenText,
  readTree,
  screenOf,
  steppedClock,
} from '../../src/testkit/index.ts';
import {
  hostKeyFingerprint,
  hostKeyLine,
  productionConfig,
  pullProject,
  ref,
  runMain,
} from '../deploy-kit.ts';
import { dialing, testServer } from '../sftp-kit.ts';

const targetBlock = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  `  host key    ${hostKeyFingerprint}  {g}verified{/}`,
  '',
];

/** A pull of the fixture's project on a terminal, with a 1.5 s clock. */
function pullFrom(
  server: ReturnType<typeof createMemoryServer>,
  root: string,
  args: readonly string[] = [],
  extra: Partial<Parameters<typeof runMain>[1]> = {},
) {
  return runMain(['pull', 'production', ...args], {
    cwd: root,
    tty: true,
    server,
    clock: steppedClock(0, 1_500),
    ...extra,
  });
}

/** The files under the project's public_html/resources, with their bytes. */
function resources(root: string): Record<string, string> {
  const base = join(root, 'public_html', 'resources');
  const files: Record<string, string> = {};
  for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(base.length + 1).replaceAll('\\', '/')] = readFileSync(path, 'latin1');
  }
  return files;
}

const latin1 = (bytes: Uint8Array | undefined): string =>
  Buffer.from(bytes ?? []).toString('latin1');

describe('sealup pull', () => {
  it('finds every file already here on a second pull, and writes nothing', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    expect((await pullFrom(server, project.root)).exitCode).toBe(0);
    const dated = statSync(join(project.root, 'public_html/resources/2024/01/photo-1.jpg')).mtimeMs;

    const again = await pullFrom(server, project.root);
    expect(screenOf(again.stderr)).toBe(
      goldenText(
        [
          ...targetBlock,
          '  {b}Pull{/}  www/resources → public_html/resources',
          `  0 new files · 4 already here (same size and date)${' '.repeat(18)}0 B`,
          '  {d}Local files are never deleted.{/}',
          '  {gb}✓ Already here:{/} 4 files checked against production in 1.5 s.',
        ],
        { color: true },
      ),
    );
    expect(again.exitCode).toBe(0);
    expect(statSync(join(project.root, 'public_html/resources/2024/01/photo-1.jpg')).mtimeMs).toBe(
      dated,
    );
  });

  it('replaces a local file whose size or date differs, and never deletes one (ruling 7)', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    const base = join(project.root, 'public_html', 'resources');
    writeFileSync(join(base, 'logo.png'), 'my own edit');
    writeFileSync(join(base, 'mine.txt'), 'only here');
    // The same bytes, another date: replaced too, so its date becomes the server's.
    const avatar = join(base, 'avatar.png');
    writeFileSync(avatar, readFileSync(avatar));

    const run = await pullFrom(server, project.root);
    expect(run.exitCode).toBe(0);
    expect(screenOf(run.stderr)).toContain(`  2 new files · 2 to replace${' '.repeat(40)}6 KB\n`);
    expect(resources(project.root)).toEqual({
      '2024/01/photo-1.jpg': latin1(project.served['2024/01/photo-1.jpg']),
      '2024/01/photo-2.jpg': latin1(project.served['2024/01/photo-2.jpg']),
      'avatar.png': latin1(project.served['avatar.png']),
      'logo.png': latin1(project.served['logo.png']),
      'mine.txt': 'only here',
    });
    for (const name of ['logo.png', 'avatar.png']) {
      expect(Math.floor(statSync(join(base, name)).mtimeMs / 1000)).toBe(project.mtime);
    }
  });

  it('--dry-run lists each download under its reason and writes nothing', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    writeFileSync(join(project.root, 'public_html/resources/logo.png'), 'my own edit');
    const run = await pullFrom(server, project.root, ['--dry-run']);
    const label = '{inv} DRY RUN {/}';
    expect(screenOf(run.stderr)).toBe(
      goldenText(
        [
          ` ${label} nothing will be downloaded from production`,
          ...targetBlock,
          '  {b}Pull{/}  www/resources → public_html/resources',
          `  {b}Would download 2 new files{/}${' '.repeat(40)}5 KB`,
          `    {g}+{/} public_html/resources/2024/01/photo-1.jpg${' '.repeat(21)}2 KB`,
          `    {g}+{/} public_html/resources/2024/01/photo-2.jpg${' '.repeat(21)}3 KB`,
          `  {b}Would replace 1 file (size or date differs){/}${' '.repeat(22)}512 B`,
          `    ~ public_html/resources/logo.png${' '.repeat(31)}512 B`,
          '  1 already here (same size and date)',
          '  {d}Local files are never deleted.{/}',
          '',
          ` ${label} nothing was downloaded. To pull: {b}sealup pull production{/}`,
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(project.root, 'public_html/resources/2024'))).toBe(false);
    expect(readFileSync(join(project.root, 'public_html/resources/logo.png'), 'utf8')).toBe(
      'my own edit',
    );
  });

  it('-q prints the target block and the result line only', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    const run = await pullFrom(server, project.root, ['-q']);
    expect(screenOf(run.stderr)).toBe(
      goldenText([...targetBlock, '  {gb}✓ Pulled{/} 2 files from production in 1.5 s.'], {
        color: true,
      }),
    );
    expect(run.stderr).not.toContain('↓');
  });

  it('skips links and special files on the server and counts them, never following one', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    server.seedLink('/home/site/www/resources/escape', '/etc');
    server.seedLink('/home/site/www/resources/2024/passwd', '/etc/passwd');
    server.seedOther('/home/site/www/resources/socket');
    const run = await pullFrom(server, project.root);
    expect(screenOf(run.stderr)).toContain(
      [
        '  \x1b[2m2 links on the server skipped: sealup never follows one.\x1b[22m',
        '  \x1b[2m1 special file on the server skipped (sockets, devices, pipes).\x1b[22m',
        '  \x1b[2mLocal files are never deleted.\x1b[22m',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(0);
    expect(Object.keys(resources(project.root)).sort()).toEqual([
      '2024/01/photo-1.jpg',
      '2024/01/photo-2.jpg',
      'avatar.png',
      'logo.png',
    ]);
  });

  it('removes the temp files an earlier pull left, and only those', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    const base = join(project.root, 'public_html', 'resources');
    writeFileSync(join(base, '.logo.png.sealup-0123456789abcdef.tmp'), 'half');
    writeFileSync(join(base, '.logo.png.sealup-draft.tmp'), 'mine');
    expect((await pullFrom(server, project.root)).exitCode).toBe(0);
    expect(existsSync(join(base, '.logo.png.sealup-0123456789abcdef.tmp'))).toBe(false);
    expect(existsSync(join(base, '.logo.png.sealup-draft.tmp'))).toBe(true);
  });

  it('copies a single server file to a local file, and the target folder itself', async () => {
    const server = createMemoryServer();
    server.seedFile('/home/site/robots.txt', 'User-agent: *\n', { mtime: 1_700_000_000 });
    const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }).replace(
      'targets:',
      'pull:\n  robots.txt: backup/robots.txt\n  .: backup/site\ntargets:',
    );
    const project = pullProject(server, { config });
    const run = await pullFrom(server, project.root);
    expect(screenOf(run.stderr)).toContain(
      '  \x1b[1mPull\x1b[22m  robots.txt → backup/robots.txt\n        . → backup/site\n',
    );
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(project.root, 'backup/robots.txt'), 'utf8')).toBe('User-agent: *\n');
    expect(readFileSync(join(project.root, 'backup/site/robots.txt'), 'utf8')).toBe(
      'User-agent: *\n',
    );
    expect(existsSync(join(project.root, 'backup/site/www/resources/logo.png'))).toBe(true);
  });

  it('copies the same files over SFTP, byte for byte', async () => {
    const sftp = await testServer({
      loginFolder: '/home/deploy',
      password: canaries.SEALUP_CANARY_PASSWORD,
    });
    const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' })
      .replace(hostKeyLine, sftp.hostKeyLine)
      .replace('targets:', 'pull:\n  www/resources: public_html/resources\ntargets:');
    const project = pullProject(sftp, { config });
    const run = await runMain(['pull', 'production'], {
      cwd: project.root,
      tty: true,
      connect: dialing(sftp),
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(resources(project.root)).toEqual(
      Object.fromEntries(
        Object.entries(project.served).map(([path, bytes]) => [path, latin1(bytes)]),
      ),
    );
    const photo = join(project.root, 'public_html/resources/2024/01/photo-2.jpg');
    expect(Math.floor(statSync(photo).mtimeMs / 1000)).toBe(project.mtime);
    // The leak test on the disk too: no file in the project, temp files included, holds the
    // password in any form (the output is checked by runMain).
    expectNoLeaks(await readTree(project.root));
  });
});

describe('sealup pull: what stops it before any local write (R10, R19)', () => {
  it.each([
    ['CON.jpg', 'Its name is reserved on Windows (CON, NUL, COM1, …).'],
    ['what?.jpg', 'Its name holds < > : " | ? or *, which Windows does not allow.'],
    ['dot.', 'Its name ends with a dot or a space, which Windows drops.'],
  ])('a server name %j: exit 6, nothing written', async (name, why) => {
    const server = createMemoryServer();
    const project = pullProject(server);
    server.seedFile(`/home/site/www/resources/2024/${name}`, 'x');
    const run = await pullFrom(server, project.root);
    expect(screenOf(run.stderr)).toContain(
      goldenText(
        [
          `  {rb}✗{/} {b}/home/site/www/resources/2024/${name} cannot be pulled as it is named.{/}`,
          `    ${why}`,
          '    sealup stopped before writing anything here. Rename it on the server,',
          '    or pull a folder that does not hold it.',
          '',
          '    Nothing was downloaded. Nothing was changed on production.',
          '    {d}More: sealup.dev/e/pull-unsafe-name{/}',
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(6);
    expect(Object.keys(resources(project.root)).sort()).toEqual(['avatar.png', 'logo.png']);
  });

  it('a link (or junction) on the local path: exit 6, nothing written through it', async () => {
    const server = createMemoryServer();
    const project = pullProject(server, { seed: true });
    const outside = join(project.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(project.root, 'public_html/resources/2024'), 'junction');
    const run = await pullFrom(server, project.root);
    expect(screenOf(run.stderr)).toContain(
      '\x1b[1mpublic_html/resources/2024 is a link: sealup pull stopped before writing anything.\x1b[22m',
    );
    expect(run.stderr).toContain('More: sealup.dev/e/pull-local-path');
    expect(run.exitCode).toBe(6);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a local file where the pull needs a folder: exit 6, the file left as it is', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    writeFileSync(join(project.root, 'public_html/resources/2024'), 'a file');
    const run = await pullFrom(server, project.root);
    expect(run.stderr).toContain(
      'public_html/resources/2024 is a file; the pull needs a folder there.',
    );
    expect(run.exitCode).toBe(6);
    expect(readFileSync(join(project.root, 'public_html/resources/2024'), 'utf8')).toBe('a file');
  });

  it('a server folder over 64 levels deep (R21): exit 6, nothing written', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    server.seedFile(`/home/site/www/resources/${Array(65).fill('d').join('/')}/deep.txt`, 'x');
    const run = await pullFrom(server, project.root);
    expect(run.stderr).toContain('folders deep: sealup stopped listing.');
    expect(run.stderr).toContain('More: sealup.dev/e/pull-too-large');
    expect(run.exitCode).toBe(6);
    expect(existsSync(join(project.root, 'public_html/resources/d'))).toBe(false);
  });
});

describe('sealup pull: the other ways it ends', () => {
  it('stops part-way when the connection drops: what arrived stays, exit 1, the rerun finishes', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    server.faults.dropDuringRead(2);
    const run = await pullFrom(server, project.root);
    expect(screenOf(run.stderr)).toContain(
      goldenText(
        [
          '  {rb}✗{/} {b}The connection to the server was lost.{/}',
          '',
          '    1 of 2 files arrived here; they stay.',
          '    Run the same command again to finish.',
          '    {d}More: sealup.dev/e/connection-lost{/}',
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(1);
    expect(Object.keys(resources(project.root))).toHaveLength(3);

    const again = await pullFrom(server, project.root);
    expect(again.exitCode).toBe(0);
    expect(again.stderr).toContain('Pulled');
    expect(Object.keys(resources(project.root))).toHaveLength(4);
  });

  it('Ctrl-C before the downloads: exit 130, nothing written', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    const controller = new AbortController();
    controller.abort();
    const run = await pullFrom(server, project.root, [], { signal: controller.signal });
    expect(run.exitCode).toBe(130);
    expect(Object.keys(resources(project.root)).sort()).toEqual(['avatar.png', 'logo.png']);
  });

  it('a server folder that is not there: exit 5, the folder named', async () => {
    const server = createMemoryServer();
    const project = pullProject(server, { seed: false });
    server.seedFile('/home/site/www/index.html', 'x');
    const run = await pullFrom(server, project.root);
    expect(run.stderr).toContain(
      'Cannot list the folder /home/site/www/resources: no such file or folder.',
    );
    expect(run.exitCode).toBe(5);
  });

  it('a target without pull entries: exit 2, the lines to add, no connection', async () => {
    const project = pullProject(createMemoryServer(), {
      config: productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }),
    });
    const run = await runMain(['pull'], { cwd: project.root, tty: true });
    expect(screenOf(run.stderr)).toBe(
      goldenText(
        [
          '  {rb}✗{/} {b}sealup.yml has no pull: entries for production.{/}',
          '    Add the server folder to copy and the local folder it goes to, like:',
          '      pull:',
          '        www/resources: public_html/resources',
          '',
          '    sealup did not connect. Nothing was downloaded. Nothing was changed on production.',
          '    {d}More: sealup.dev/e/no-pull-entries{/}',
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(2);
  });

  it('no host key: exit 4 before connecting; a refused login: exit 3; nothing written', async () => {
    const server = createMemoryServer();
    const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD', hostKey: false });
    const keyless = pullProject(server, {
      config: config.replace('targets:', 'pull:\n  www/resources: public_html/resources\ntargets:'),
    });
    // No server given to the run: connecting would fail the test.
    const missing = await runMain(['pull'], { cwd: keyless.root, tty: true });
    expect(missing.stderr).toContain('Run on your machine:  sealup keyscan production');
    expect(missing.exitCode).toBe(4);

    const project = pullProject(server, { seed: false });
    server.faults.refuseLogin();
    const refused = await pullFrom(server, project.root);
    expect(refused.stderr).toContain('Login refused by ssh.example.com for user deploy.');
    expect(refused.exitCode).toBe(3);
    expect(Object.keys(resources(project.root)).sort()).toEqual(['avatar.png', 'logo.png']);
  });

  it('an unknown target: the did-you-mean names sealup pull', async () => {
    const project = pullProject(createMemoryServer());
    const run = await runMain(['pull', 'productoin'], { cwd: project.root, tty: true });
    expect(run.stderr).toContain('Did you mean production?  sealup pull production');
    expect(run.exitCode).toBe(2);
  });

  it('asks with the picker when several targets exist, then names the target to skip it', async () => {
    const server = createMemoryServer();
    const config = [
      'upload: public_html',
      'pull:',
      '  www/resources: public_html/resources',
      'targets:',
      '  production:',
      '    server: sftp://deploy@ssh.example.com:22/home/site',
      `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      `    hostKey: ${hostKeyLine}`,
      '  staging:',
      '    server: sftp://deploy@203.0.113.10/srv/site',
      `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      `    hostKey: ${hostKeyLine}`,
      '',
    ].join('\n');
    const project = pullProject(server, { config });
    const run = await runMain(['pull'], { cwd: project.root, tty: true, server, keys: ['\r'] });
    const screen = screenOf(run.stderr);
    expect(screen).toContain('Pull from which target?');
    expect(screen).toContain('\x1b[2mNext time, skip the question: sealup pull production\x1b[22m');
    expect(run.exitCode).toBe(0);
  });

  it('--json gives a pull object: downloaded, already here, bytes; a dry run its downloads', async () => {
    const server = createMemoryServer();
    const project = pullProject(server);
    const dry = await pullFrom(server, project.root, ['--dry-run', '--json']);
    expect(JSON.parse(dry.stdout)).toEqual({
      format: 1,
      version: '0.0.0-source',
      command: 'pull',
      target: 'production',
      server: 'sftp://deploy@ssh.example.com:22/home/site',
      url: 'https://example.com',
      dryRun: true,
      status: 'ok',
      exitCode: 0,
      downloaded: 2,
      unchanged: 2,
      bytes: 5120,
      durationMs: 1500,
      timings: expect.any(Object),
      ops: [
        {
          op: 'download',
          path: 'public_html/resources/2024/01/photo-1.jpg',
          reason: 'new',
          size: 2048,
        },
        {
          op: 'download',
          path: 'public_html/resources/2024/01/photo-2.jpg',
          reason: 'new',
          size: 3072,
        },
      ],
    });
    const real = await pullFrom(server, project.root, ['--json']);
    expect(JSON.parse(real.stdout)).toMatchObject({
      command: 'pull',
      dryRun: false,
      status: 'ok',
      downloaded: 2,
      unchanged: 2,
      bytes: 5120,
    });
  });
});
