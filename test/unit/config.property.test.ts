import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { propertyOptions } from '../property-kit.ts';

describe('literal config secret properties (R3, R6)', () => {
  let folder = '';
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'sealup-property-config-'));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('rejects generated literal credentials without copying their contents into issues', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 80 }), async (value) => {
        const secret = `canary-property-${value}`;
        const file = join(folder, 'sealup.yml');
        writeFileSync(
          file,
          [
            'server: sftp://deploy@ssh.example.com/home/site',
            `password: ${JSON.stringify(secret)}`,
            'upload: dist',
          ].join('\n'),
        );
        const result = await loadConfig(file, {});
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('literal secret accepted');
        expect(JSON.stringify(result.issues)).not.toContain('canary-property-');
      }),
      { ...propertyOptions, numRuns: 100 },
    );
  }, 30_000);
});
