// The hash cache as a deploy keeps it (spec #41 decision 25; seam 1): one file per project in the
// user's cache folder (%LOCALAPPDATA%\sealup on Windows, $XDG_CACHE_HOME/sealup or
// ~/.cache/sealup elsewhere), never in the project, and never holding a file written from a
// secret. Every cache folder here is a fresh temp folder named in the run's environment.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canaries, createMemoryServer, expectNoLeaks } from '../../src/testkit/index.ts';
import { createProject, productionConfig, ref, runMain } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const site = { 'public_html/index.html': '<h1>home</h1>', 'public_html/css/site.css': 'a{}' };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tempFolder(name: string): string {
  const folder = mkdtempSync(join(tmpdir(), `sealup ${name} `));
  folders.push(folder);
  return folder;
}

/** A project of the page's production target whose files were built a day ago. */
function builtYesterday(config = productionConfig()): { root: string; files: string[] } {
  const project = createProject(config, site);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const files = Object.keys(site).map((path) => join(project.root, ...path.split('/')));
  for (const file of files) utimesSync(file, yesterday, yesterday);
  return { root: project.root, files };
}

/** Every file below `folder`, `/`-separated, in order. */
function tree(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(folder.length + 1)
        .replaceAll('\\', '/'),
    )
    .sort();
}

async function deployOnce(
  root: string,
  options: { readonly env: Readonly<Record<string, string>>; readonly platform: string },
): Promise<void> {
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  const run = await runMain(['deploy'], {
    cwd: root,
    env: { ...env, ...options.env },
    platform: options.platform,
    server,
  });
  expect(run.exitCode, run.stderr).toBe(0);
}

describe('the hash cache a deploy keeps', () => {
  it('lives in %LOCALAPPDATA%\\sealup on Windows, one file, the project untouched', async () => {
    const { root } = builtYesterday();
    const before = tree(root);
    const local = tempFolder('local app data');

    await deployOnce(root, { env: { LOCALAPPDATA: local }, platform: 'win32' });

    expect(tree(local)).toEqual([expect.stringMatching(/^sealup\/[0-9a-f]{16}\.json$/)]);
    expect(tree(root)).toEqual(before);
  });

  it('lives in $XDG_CACHE_HOME/sealup elsewhere, before ~/.cache', async () => {
    const { root } = builtYesterday();
    const xdg = tempFolder('xdg cache');
    const home = tempFolder('home');

    await deployOnce(root, { env: { XDG_CACHE_HOME: xdg, HOME: home }, platform: 'linux' });

    expect(tree(xdg)).toEqual([expect.stringMatching(/^sealup\/[0-9a-f]{16}\.json$/)]);
    expect(tree(home)).toEqual([]);
  });

  it('lives in ~/.cache/sealup without $XDG_CACHE_HOME, or with a relative one', async () => {
    const { root } = builtYesterday();
    const home = tempFolder('home');

    await deployOnce(root, { env: { HOME: home }, platform: 'darwin' });
    await deployOnce(root, { env: { HOME: home, XDG_CACHE_HOME: 'cache' }, platform: 'linux' });

    expect(tree(home)).toEqual([expect.stringMatching(/^\.cache\/sealup\/[0-9a-f]{16}\.json$/)]);
    expect(existsSync(join(root, 'cache'))).toBe(false);
  });

  it('is not kept on Windows without %LOCALAPPDATA%, nor where no cache folder is known', async () => {
    const { root } = builtYesterday();
    const before = tree(root);
    const home = tempFolder('home');

    await deployOnce(root, { env: { HOME: home }, platform: 'win32' });
    await deployOnce(root, { env: {}, platform: 'linux' });

    expect(tree(home)).toEqual([]);
    expect(tree(root)).toEqual(before);
  });

  it('holds the uploaded files, never a file written from a secret', async () => {
    const writing = `${productionConfig()}write:\n  api/.env: ${ref('SEALUP_CANARY_MULTILINE')}\n`;
    const { root, files } = builtYesterday(writing);
    const xdg = tempFolder('xdg cache');

    await deployOnce(root, { env: { XDG_CACHE_HOME: xdg }, platform: 'linux' });

    const [name] = tree(xdg);
    const text = readFileSync(join(xdg, ...(name ?? '').split('/')), 'utf8');
    for (const file of files) expect(text).toContain(JSON.stringify(file));
    expectNoLeaks({ cache: text, parsed: JSON.parse(text) });
    const secret = canaries.SEALUP_CANARY_MULTILINE;
    expect(text).not.toContain(createHash('sha256').update(secret).digest('hex'));
    expect(text).not.toContain('.env');
  });
});
