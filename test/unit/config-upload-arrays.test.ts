import { describe, expect, it } from 'vitest';
import { issuesOf, load, ref, targetIssues, targetOf } from '../config-kit.ts';

describe('one upload source with multiple destinations', () => {
  it('expands ordered destinations into mappings with separate options and locations', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload:',
        '  api:',
        '    - api',
        '    - to: designer/api',
        '      mirror: true',
        '      exclude: [storage/, .env*]',
      ].join('\n'),
    );
    expect(targetOf(result, 'ssh.example.com').uploads).toMatchObject([
      { remote: 'api', place: { line: 5, keyPath: 'upload.api.0' } },
      {
        remote: 'designer/api',
        mirror: true,
        exclude: ['storage/', '.env*'],
        place: { line: 6, keyPath: 'upload.api.1' },
      },
    ]);
  });

  it('points an invalid option at the offending destination and field', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload:',
        '  api:',
        '    - api',
        '    - to: designer/api',
        '      mirror: always',
      ].join('\n'),
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 7, keyPath: 'upload.api.1.mirror', expected: 'yes-no' },
    ]);
  });

  it('keeps path failures attached to the exact destination', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload:',
        '  api: [api, ../unsafe]',
      ].join('\n'),
    );
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'remote-path', keyPath: 'upload.api.1' },
    ]);
  });

  it('refuses an empty destination array', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload:',
        '  api: []',
      ].join('\n'),
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', keyPath: 'upload.api', expected: 'upload-entry' },
    ]);
  });
});
