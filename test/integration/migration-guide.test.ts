import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { scanLocal } from '../../src/scan/index.ts';

it('the guide selects each current env without source copies or runtime data', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sealup-guide-fixture-'));
  const page = readFileSync(
    join(import.meta.dirname, '../../site/src/content/docs/migrate-sam-sync.md'),
    'utf8',
  );
  const config = /```yaml\n([\s\S]+?)\n```/.exec(page)?.[1];
  assert.ok(config, 'the guide must contain its working config');
  try {
    const files = {
      'root/public_html/index.html': '<p>fixture</p>',
      'root/public_html/resources/keep.jpg': 'runtime resource',
      'root/api/app.php': '<?php',
      'root/api/storage/session': 'runtime storage',
      'root/api/.env': 'APP_ENV=local',
      'root/api/.env.prod': 'APP_ENV=production',
      'root/api/.env.preview': 'APP_ENV=preview',
      'root/docker-compose.yml': 'services: {}',
      'root/docker-compose.preview.yml': 'services: {}',
    };
    for (const [name, value] of Object.entries(files)) {
      const file = join(folder, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, value);
    }
    const file = join(folder, 'sealup.yml');
    writeFileSync(file, config);
    const loaded = await loadConfig(file, {
      PRODUCTION_SERVER: 'sftp://fixture@ssh.example.com/sites/production',
      PREVIEW_SERVER: 'sftp://fixture@ssh.example.com/sites/preview',
      SEALUP_PASSWORD: 'synthetic-password',
      SEALUP_HOST_KEY:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86',
    });
    assert.equal(loaded.ok, true, 'the guide config must load');
    if (!loaded.ok) return;
    const targets = [
      ['production', '.env.prod'],
      ['preview', '.env.preview'],
    ] as const;
    for (const [name, source] of targets) {
      const target = loaded.config.targets.get(name);
      expect(target?.ok, `${name} must resolve`).toBe(true);
      if (!target?.ok) continue;
      const scanned = await scanLocal(target.target.uploads, target.target.exclude);
      assert.deepEqual([...scanned.files.keys()].sort(), [
        'api/.env',
        'api/app.php',
        'docker-compose.yml',
        'public_html/index.html',
      ]);
      assert.equal(
        scanned.sent.find((entry) => entry.path === 'api/.env')?.mapping.local,
        join(folder, 'root/api', source),
      );
      assert.equal(scanned.emptySources.length, 0);
      assert.equal(scanned.symlinks.length, 0);
    }
  } finally {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(folder.includes('sealup-guide-fixture-'));
    rmSync(folder, { recursive: true, force: true });
  }
});
