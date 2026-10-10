// config, `pull` (decision 0022, spec #24 decision 25, R19): `remote: local` pairs for `sealup
// pull`, top level and per target. The server side is a folder or a file under the target folder;
// the local side stays inside the folder of sealup.yml. Problems land at their place, never with
// a value (R6).

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issuesOf, load, ref, targetIssues, targetOf } from '../config-kit.ts';

const shorthand = (...lines: string[]): string =>
  [
    'server: sftp://deploy@ssh.example.com/home/site',
    `password: ${ref('SEALUP_PASSWORD')}`,
    'upload: dist',
    ...lines,
  ].join('\n');

const target = 'ssh.example.com';

describe('loadConfig: pull (spec #24 decision 25)', () => {
  it('takes remote: local pairs, the local side from the folder of sealup.yml', async () => {
    const { result, folder, file } = await load(
      shorthand('pull:', '  www/resources: public_html/resources', '  .: backup'),
    );
    expect(targetOf(result, target).pulls).toEqual([
      {
        remote: 'www/resources',
        local: join(folder, 'public_html', 'resources'),
        localFromConfig: 'public_html/resources',
        place: { file, line: 5, keyPath: 'pull.www/resources' },
      },
      {
        remote: '',
        local: join(folder, 'backup'),
        localFromConfig: 'backup',
        place: { file, line: 6, keyPath: 'pull..' },
      },
    ]);
  });

  it('has no pull entries when the config has none', async () => {
    const { result } = await load(shorthand());
    expect(targetOf(result, target).pulls).toEqual([]);
  });

  it("adds a target's own entries to the shared list", async () => {
    const { result } = await load(
      [
        'upload: dist',
        'pull:',
        '  www/resources: public_html/resources',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
        '    pull:',
        '      api/storage/app: api/storage/app',
        '  staging:',
        '    server: sftp://deploy@203.0.113.10/srv/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
      ].join('\n'),
    );
    expect(targetOf(result, 'production').pulls.map((entry) => entry.remote)).toEqual([
      'www/resources',
      'api/storage/app',
    ]);
    expect(targetOf(result, 'staging').pulls.map((entry) => entry.remote)).toEqual([
      'www/resources',
    ]);
  });

  it.each([
    ['../outside', 'a folder above sealup.yml'],
    ['.', 'the folder of sealup.yml itself'],
    ['public_html/../..', 'a way out through ..'],
    ['/tmp/x', 'an absolute folder'],
  ])('refuses %j as the local side (%s): the target cannot pull', async (local) => {
    const { result, file } = await load(shorthand('pull:', `  www/resources: '${local}'`));
    expect(targetIssues(result, target)).toEqual([
      { code: 'bad-path', file, line: 5, keyPath: 'pull.www/resources', detail: 'pull' },
    ]);
  });

  it.each(['../www', '/home/site/www', 'a//b'])(
    'refuses %j as the server side: a path in the target folder only (R10)',
    async (remote) => {
      const { result, file } = await load(shorthand('pull:', `  '${remote}': resources`));
      expect(targetIssues(result, target)).toEqual([
        { code: 'remote-path', file, line: 5, keyPath: `pull.${remote}`, detail: 'pull' },
      ]);
    },
  );

  it('refuses a list or a nested entry with its place', async () => {
    const list = await load(shorthand('pull: [www]'));
    expect(issuesOf(list.result)).toEqual([
      { code: 'wrong-type', file: list.file, line: 4, keyPath: 'pull', expected: 'pull' },
    ]);
    const nested = await load(shorthand('pull:', '  www:', '    to: x'));
    expect(issuesOf(nested.result)).toEqual([
      { code: 'wrong-type', file: nested.file, line: 5, keyPath: 'pull.www', expected: 'text' },
    ]);
  });
});
