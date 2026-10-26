import { describe, expect, it } from 'vitest';
import { load, ref, targetIssues, targetOf } from '../config-kit.ts';

describe('named targets without root uploads', () => {
  it('uses target uploads without needing an empty shared mapping', async () => {
    const { result } = await load(
      [
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
        '    upload: dist',
      ].join('\n'),
    );
    expect(targetOf(result, 'production').uploads).toMatchObject([
      { localFromConfig: 'dist', remote: '' },
    ]);
  });

  it('rejects a target that has no operations, including empty maps', async () => {
    const { result } = await load(
      [
        'targets:',
        '  empty:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
        '    upload: {}',
        '    pull: {}',
        '    write: {}',
      ].join('\n'),
    );
    expect(targetIssues(result, 'empty')).toMatchObject([
      { code: 'missing-key', keyPath: 'targets.empty.upload', expected: 'operations' },
    ]);
  });

  it.each(['pull: {resources: local/resources}', `write: {api/.env: "${ref('APP_ENV')}"}`])(
    'accepts a shared operation with no uploads: %s',
    async (operation) => {
      const { result } = await load(
        [
          operation,
          'targets:',
          '  production:',
          '    server: sftp://deploy@ssh.example.com/home/site',
          `    password: ${ref('SEALUP_PASSWORD')}`,
        ].join('\n'),
        { SEALUP_PASSWORD: 'pw-1234', APP_ENV: 'APP_ENV=production' },
      );
      const target = targetOf(result, 'production');
      expect(target.uploads).toEqual([]);
      expect(target.pulls.length + target.writes.length).toBe(1);
    },
  );
});
