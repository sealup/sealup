// config, the files around sealup.yml (ticket 09, decision 0022 §1, §7): finding sealup.yml from
// the current folder up to the repo root, and reading sealup.env or --env-file into the variables
// `${VAR}` may name, the environment winning.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findConfig, loadConfig } from '../../src/config/index.ts';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A temp folder (its name holds a space) with the given files; `/` ending = a folder. */
function tree(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sealup files '));
  folders.push(root);
  for (const path of files) {
    const full = join(root, ...path.split('/'));
    if (path.endsWith('/')) mkdirSync(full, { recursive: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '');
    }
  }
  return root;
}

describe('findConfig: sealup.yml from the current folder up to the repo root', () => {
  it('finds sealup.yml in the current folder', async () => {
    const root = tree(['.git/', 'sealup.yml']);
    expect(await findConfig(root)).toEqual({ ok: true, file: join(root, 'sealup.yml') });
  });

  it('finds sealup.yaml too', async () => {
    const root = tree(['.git/', 'sealup.yaml']);
    expect(await findConfig(root)).toEqual({ ok: true, file: join(root, 'sealup.yaml') });
  });

  it('looks in each parent folder, the nearest first', async () => {
    const root = tree(['.git/', 'sealup.yml', 'site/sealup.yml', 'site/src/app/']);
    expect(await findConfig(join(root, 'site', 'src', 'app'))).toEqual({
      ok: true,
      file: join(root, 'site', 'sealup.yml'),
    });
  });

  it('stops at the repo root: the nearest folder holding .git, a file in a worktree', async () => {
    const root = tree(['sealup.yml', 'repo/.git', 'repo/src/']);
    const result = await findConfig(join(root, 'repo', 'src'));
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: 'file-not-found',
          file: join(root, 'repo', 'src', 'sealup.yml'),
          keyPath: '',
          searchedUpTo: join(root, 'repo'),
        },
      ],
    });
  });

  it('looks in the current folder only outside a repo', async () => {
    const root = tree(['sealup.yml', 'site/']);
    const result = await findConfig(join(root, 'site'));
    expect(result).toEqual({
      ok: false,
      issues: [{ code: 'file-not-found', file: join(root, 'site', 'sealup.yml'), keyPath: '' }],
    });
  });

  it('refuses a folder holding both sealup.yml and sealup.yaml', async () => {
    const root = tree(['.git/', 'sealup.yml', 'sealup.yaml', 'site/']);
    expect(await findConfig(join(root, 'site'))).toEqual({
      ok: false,
      issues: [{ code: 'file-ambiguous', file: join(root, 'sealup.yml'), keyPath: '' }],
    });
  });
});

describe('loadConfig: sealup.env and --env-file (decision 0022 §7)', () => {
  const config = [
    `server: sftp://$\{SITE_USER}@ssh.example.com/home/site`,
    `password: $\{SEALUP_PASSWORD}`,
    'upload: dist',
  ].join('\n');

  /** The server user the config resolves to, from SITE_USER. */
  async function userOf(
    files: readonly [string, string][],
    env: Record<string, string>,
    options: { envFile?: string } = {},
  ): Promise<string> {
    const root = tree([]);
    writeFileSync(join(root, 'sealup.yml'), config);
    for (const [name, text] of files) writeFileSync(join(root, name), text);
    const result = await loadConfig(join(root, 'sealup.yml'), env, {
      ...(options.envFile === undefined ? {} : { envFile: join(root, options.envFile) }),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const entry = result.config.targets.get('ssh.example.com');
    if (entry?.ok !== true) throw new Error(JSON.stringify(entry));
    return entry.target.server.user;
  }

  it('reads sealup.env next to sealup.yml', async () => {
    const user = await userOf([['sealup.env', 'SITE_USER=from-file\n']], {
      SEALUP_PASSWORD: 'pw-for-tests',
    });
    expect(user).toBe('from-file');
  });

  it('lets a variable already in the environment win over the file', async () => {
    const user = await userOf([['sealup.env', 'SITE_USER=from-file\n']], {
      SEALUP_PASSWORD: 'pw-for-tests',
      SITE_USER: 'from-env',
    });
    expect(user).toBe('from-env');
  });

  it('counts an empty variable in the environment as not set (GitHub passes empty secrets)', async () => {
    const user = await userOf([['sealup.env', 'SITE_USER=from-file\n']], {
      SEALUP_PASSWORD: 'pw-for-tests',
      SITE_USER: '',
    });
    expect(user).toBe('from-file');
  });

  it('reads the --env-file instead of sealup.env', async () => {
    const user = await userOf(
      [
        ['sealup.env', 'SITE_USER=from-sealup-env\n'],
        ['other.env', 'SITE_USER=from-other\nSEALUP_PASSWORD=pw-for-tests\n'],
      ],
      {},
      { envFile: 'other.env' },
    );
    expect(user).toBe('from-other');
  });

  it('never changes process.env', async () => {
    await userOf([['sealup.env', 'SEALUP_T09_CANARY=x\nSITE_USER=u\n']], {
      SEALUP_PASSWORD: 'pw-for-tests',
    });
    expect(process.env.SEALUP_T09_CANARY).toBeUndefined();
  });

  it('says when the --env-file is missing', async () => {
    const root = tree(['sealup.yml']);
    const envFile = join(root, 'missing.env');
    expect(await loadConfig(join(root, 'sealup.yml'), {}, { envFile })).toEqual({
      ok: false,
      issues: [{ code: 'env-file-not-found', file: envFile, keyPath: '' }],
      secrets: [],
    });
  });
});
