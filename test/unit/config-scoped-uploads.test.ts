import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemotePath } from '../../src/contracts/index.ts';
import { scanLocal } from '../../src/scan/index.ts';
import { load, ref, targetIssues, targetOf } from '../config-kit.ts';

describe('folder-scoped upload exclusions', () => {
  it('does not hash globally excluded files or follow scoped excluded links', async () => {
    const { result, folder } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'exclude: [api/private.txt]',
        'upload:',
        '  api:',
        '    to: api',
        '    exclude: [linked, "!private.txt"]',
      ].join('\n'),
      undefined,
      {
        'api/app.php': '<?php',
        'api/private.txt': 'private',
        'outside/secret.txt': 'outside',
      },
    );
    symlinkSync(
      join(folder, 'outside'),
      join(folder, 'api/linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const target = targetOf(result, 'ssh.example.com');
    const scanned = await scanLocal(target.uploads, target.exclude);
    expect([...scanned.files.keys()]).toEqual(['api/app.php']);
    expect(scanned.symlinks).toEqual([]);
    expect(scanned.hashed).toBe(1);
  });

  it('resolves scoped pattern variables and reports their exact location when missing', async () => {
    const yaml = [
      'server: sftp://deploy@ssh.example.com/home/site',
      `password: ${ref('SEALUP_PASSWORD')}`,
      'upload:',
      '  api:',
      '    - to: api',
      `      exclude: ["${ref('RUNTIME_EXCLUDE')}"]`,
    ].join('\n');
    const missing = await load(yaml);
    expect(targetIssues(missing.result, 'ssh.example.com')).toMatchObject([
      {
        code: 'variable-not-set',
        line: 6,
        keyPath: 'upload.api.0.exclude.0',
        variable: 'RUNTIME_EXCLUDE',
      },
    ]);
    const present = await load(yaml, { SEALUP_PASSWORD: 'pw-1234', RUNTIME_EXCLUDE: 'storage/' });
    expect(targetOf(present.result, 'ssh.example.com').uploads[0]?.exclude).toEqual(['storage/']);
  });
  it('keeps global exclusions authoritative even when scoped negations try to include them', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'exclude: [api/.env*]',
        'upload:',
        '  api:',
        '    to: api',
        '    exclude: ["!.env.prod"]',
        '  api/.env.prod: api/.env',
      ].join('\n'),
      undefined,
      { 'api/.env.prod': 'APP_ENV=production' },
    );
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'excluded-file', keyPath: 'upload.api/.env.prod', other: { keyPath: 'exclude.0' } },
    ]);
  });

  it('refuses folder-scoped exclusions on a single file rather than ignoring them', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload:',
        '  env.prod:',
        '    to: api/.env',
        '    exclude: ["*"]',
      ].join('\n'),
      undefined,
      { 'env.prod': 'APP_ENV=production' },
    );
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'wrong-type', keyPath: 'upload.env.prod.exclude', expected: 'folder-exclude' },
    ]);
  });
  it('uploads the current selected env file without uploading the other env files', async () => {
    const { result, folder } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload:',
        '  api:',
        '    to: api',
        '    exclude: [.env*, storage/]',
        '  api/.env.prod: api/.env',
      ].join('\n'),
      undefined,
      {
        'api/app.php': '<?php',
        'api/.env': 'APP_ENV=local',
        'api/.env.prod': 'APP_ENV=production',
        'api/.env.other': 'APP_ENV=other',
        'api/storage/session': 'runtime',
      },
    );
    const target = targetOf(result, 'ssh.example.com');
    const first = await scanLocal(target.uploads, target.exclude);
    expect([...first.files.keys()]).toEqual(['api/.env', 'api/app.php']);
    writeFileSync(join(folder, 'api/.env.prod'), 'APP_ENV=production-updated');
    const next = await scanLocal(target.uploads, target.exclude);
    expect(next.files.get('api/.env' as RemotePath)?.sha256).not.toBe(
      first.files.get('api/.env' as RemotePath)?.sha256,
    );
    expect([...next.files.keys()]).toEqual(['api/.env', 'api/app.php']);
  });
});
