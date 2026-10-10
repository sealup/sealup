// Single files in `upload` (scope v1, spec #24 decision 23; seam 1, deploy() behind the Session
// port): a local file sent under another name, tracked like any uploaded file; the nets a single
// file meets before connecting. Over the memory server, then the same deploy over real SFTP.

import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import type { Connect } from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { createMemoryServer, goldenText, steppedClock } from '../../src/testkit/index.ts';
import {
  createProject,
  eventLog,
  hostKeyLine,
  manifestPaths,
  memorySite,
  productionConfig,
  runMain,
  siteFiles,
  versionLine,
} from '../deploy-kit.ts';
import { dialing, testServer } from '../sftp-kit.ts';

const build = {
  'public_html/index.html': '<h1>home</h1>',
  'public_html/connect.php': '<?php // dev',
  'config/connect.prod.php': '<?php // production',
};

/** `upload:` lines under the page's production target (line 1 is `upload:`). */
const uploading = (...entries: string[]): string =>
  productionConfig({ upload: ['', ...entries.map((entry) => `  ${entry}`)].join('\n') });

/** public_html to the target folder, its dev connect.php excluded, the production one swapped in. */
const swapped = `${uploading('public_html: .', 'config/connect.prod.php: connect.php')}exclude: [public_html/connect.php]\n`;

const noConnect: Connect = () => {
  throw new Error('this run must not connect');
};

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

describe('single files: deployed and tracked like any uploaded file', () => {
  it('sends a single file under its server name, records it, and skips it when unchanged', async () => {
    const s = await memorySite(build, { config: swapped });

    const first = await s.run();

    expect(first.outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 2 });
    expect(siteFiles(s.server)).toEqual(['connect.php', 'index.html']);
    expect(text(s.server.files().get('/home/site/connect.php')?.bytes)).toBe('<?php // production');
    expect(await manifestPaths(s.server)).toEqual(['connect.php', 'index.html']);

    const again = await s.run();
    expect(again.outcome).toMatchObject({ status: 'unchanged', uploaded: 0, unchanged: 2 });
  });

  it('sends it again when its content changed', async () => {
    const s = await memorySite(build, { config: swapped });
    await s.run();
    s.write('config/connect.prod.php', '<?php // production v2');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 1, unchanged: 1, deleted: 0 });
    expect(text(s.server.files().get('/home/site/connect.php')?.bytes)).toBe(
      '<?php // production v2',
    );
  });

  it('deletes it once its entry leaves the config: it is tool-owned', async () => {
    const s = await memorySite(build, {
      config: uploading('public_html: www', 'config/connect.prod.php: api/connect.php'),
    });
    await s.run();
    s.setConfig(uploading('public_html: www'));

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 0, deleted: 1 });
    expect(siteFiles(s.server)).toEqual(['www/connect.php', 'www/index.html']);
    expect(await manifestPaths(s.server)).toEqual(['www/connect.php', 'www/index.html']);
  });

  it('makes the folders its server path needs', async () => {
    const s = await memorySite(build, {
      config: uploading('public_html: www', 'config/connect.prod.php: api/config/connect.php'),
    });
    const { outcome } = await s.run();
    expect(outcome).toMatchObject({ status: 'ok', uploaded: 3 });
    expect(siteFiles(s.server)).toEqual([
      'api/config/connect.php',
      'www/connect.php',
      'www/index.html',
    ]);
  });
});

describe('single files: stopped before connecting', () => {
  it('two entries sending one server path: exit 2 naming both lines, nothing sent', async () => {
    const s = await memorySite(build, {
      config: uploading('public_html: .', 'config/connect.prod.php: connect.php'),
    });

    const { outcome, events } = await s.run(noConnect);

    expect(outcome).toMatchObject({
      status: 'failed',
      exitCode: 2,
      problem: {
        code: 'config',
        target: 'production',
        issues: [
          {
            code: 'same-server-path',
            line: 3,
            keyPath: 'upload.config/connect.prod.php',
            other: { line: 2, keyPath: 'upload.public_html' },
            path: 'connect.php',
          },
        ],
      },
    });
    expect(events.map((event) => event.type)).toEqual(['done']);
    expect(s.server.files().size).toBe(0);
  });

  it('a single file an exclude pattern matches: exit 2 naming both lines', async () => {
    const project = createProject(
      `${uploading('public_html: .', 'config/connect.prod.php: connect.php')}exclude: ['*.php']\n`,
      build,
    );
    const loaded = await loadConfig(project.config, { PROD_PASSWORD: 'pw-for-tests' });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const log = eventLog();

    const outcome = await deploy(
      { config: loaded.config, target: 'production' },
      { connect: noConnect, emit: log.emit, signal: undefined, clock: steppedClock(0) },
    );

    expect(outcome).toMatchObject({
      exitCode: 2,
      problem: {
        code: 'config',
        issues: [
          {
            code: 'excluded-file',
            line: 3,
            keyPath: 'upload.config/connect.prod.php',
            other: { line: 10, keyPath: 'exclude.0' },
          },
        ],
      },
    });
    expect(log.events.map((event) => event.type)).toEqual(['done']);
  });

  it('a missing local file is the missing-source net: exit 6', async () => {
    const s = await memorySite(
      { 'public_html/index.html': 'x' },
      { config: uploading('public_html: .', 'config/connect.prod.php: connect.php') },
    );
    const { outcome } = await s.run(noConnect);
    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'empty-source', folder: 'config/connect.prod.php', missing: true },
    });
  });

  // Spec #24 decision 23, safe side: a local path that is not there is never planned as a source
  // that sends nothing, so the server copy of an entry still in the config is never deleted.
  it('a missing local file stops even with allow: [empty-source]; its server copy stays', async () => {
    const allowed = swapped.replace(
      '  production:\n',
      '  production:\n    allow: [empty-source]\n',
    );
    const s = await memorySite(build, { config: allowed });
    expect((await s.run()).outcome).toMatchObject({ status: 'ok', uploaded: 2 });
    s.remove('config/connect.prod.php');

    const { outcome } = await s.run();

    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'empty-source', folder: 'config/connect.prod.php', missing: true },
    });
    expect(siteFiles(s.server)).toEqual(['connect.php', 'index.html']);
    expect(await manifestPaths(s.server)).toEqual(['connect.php', 'index.html']);
  });

  it('a single file gone between reading the config and the scan: exit 6 the same way', async () => {
    const project = createProject(swapped, build);
    const loaded = await loadConfig(project.config, { PROD_PASSWORD: 'pw-for-tests' });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    rmSync(join(project.root, 'config', 'connect.prod.php'));

    const outcome = await deploy(
      { config: loaded.config, target: 'production' },
      { connect: noConnect, emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );

    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: { code: 'empty-source', folder: 'config/connect.prod.php', missing: true },
    });
  });

  it('a single file that is a link is the symlink net: exit 6, never followed', async () => {
    const project = createProject(swapped, {
      'public_html/index.html': 'x',
      'secrets/id_rsa': 'not for the web',
      'config/README': 'connect.prod.php links to the real one',
    });
    symlinkSync(
      join(project.root, 'secrets', 'id_rsa'),
      join(project.root, 'config', 'connect.prod.php'),
      'file',
    );
    const loaded = await loadConfig(project.config, { PROD_PASSWORD: 'pw-for-tests' });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));

    const outcome = await deploy(
      { config: loaded.config, target: 'production' },
      { connect: noConnect, emit: () => {}, signal: undefined, clock: steppedClock(0) },
    );

    expect(outcome).toMatchObject({
      exitCode: 6,
      problem: {
        code: 'symlink',
        on: 'source',
        path: 'config/connect.prod.php',
        target: 'production',
      },
    });
  });
});

describe('single files: as main() prints the stop (seam 2)', () => {
  it('names both lines that send one server path, before connecting, and exits 2', async () => {
    const project = createProject(
      uploading('public_html: .', 'config/connect.prod.php: connect.php'),
      build,
    );

    // No server: a run that connects fails the test.
    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
    });

    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy', 'production'),
          '  {rb}✗{/} {b}Two entries in sealup.yml send connect.php.{/}',
          '    upload.config/connect.prod.php (line 3) sends it,',
          '    and so does upload.public_html (line 2).',
          '    sealup will not guess which one wins: change one of the two lines.',
          '',
          '    sealup did not connect. Nothing was changed on production.',
          '    {d}More: sealup.dev/e/same-server-path{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(2);
  });

  // A path that is not there could be a file or a folder: the words claim neither (no `/`), and
  // allow: [empty-source] is no way out (an existing empty folder only).
  it('says a missing local path does not exist, without calling it a folder, and exits 6', async () => {
    const project = createProject(swapped, {
      'public_html/index.html': '<h1>home</h1>',
      'public_html/connect.php': '<?php // dev',
    });

    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: { PROD_PASSWORD: 'pw-for-tests' },
    });

    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy', 'production'),
          '  {rb}✗{/} {b}config/connect.prod.php does not exist: sealup stopped before connecting.{/}',
          '    Deploying without it would delete what sealup put at /home/site/connect.php.',
          '    Most likely the build failed or wrote its files somewhere else.',
          '    Run your build, check that it makes config/connect.prod.php, then deploy again.',
          '    {d}If it is gone for good, remove its upload: entry (line 3).{/}',
          '',
          '    Nothing was changed on production.',
          '    {d}More: sealup.dev/e/empty-source{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(6);
  });
});

describe('single files over SFTP', () => {
  it('leaves the same server tree as the memory server, and is unchanged on a redeploy', async () => {
    const sftp = await testServer({ loginFolder: '/home/deploy' });
    const project = createProject(swapped.replace(hostKeyLine, sftp.hostKeyLine), build);
    const loaded = await loadConfig(project.config, { PROD_PASSWORD: sftp.password });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const run = (connect: Connect) =>
      deploy(
        { config: loaded.config, target: 'production' },
        { connect, emit: () => {}, signal: undefined, clock: steppedClock(0) },
      );
    const memory = createMemoryServer({ loginFolder: '/home/deploy' });

    const overSftp = await run(dialing(sftp));
    const inMemory = await run(() => memory.connect());

    expect(overSftp).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 2 });
    expect(overSftp).toEqual(inMemory);
    const tree = (server: typeof memory | typeof sftp) =>
      Object.fromEntries([...server.files()].map(([path, file]) => [path, file.sha256]));
    expect(tree(sftp)).toEqual(tree(memory));
    expect(text(sftp.files().get('/home/site/connect.php')?.bytes)).toBe('<?php // production');

    expect(await run(dialing(sftp))).toMatchObject({ status: 'unchanged', unchanged: 2 });
  });
});
