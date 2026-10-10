// config, `upload` and `exclude` (decision 0022 §3, ticket 06, spec #24 decision 23): folders to
// folders under the target folder, single files to file paths under it, the shared lists and a
// target's own, and every problem at its place (file, line, key path).

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { issuesOf, load, ref, targetIssues, targetOf } from '../config-kit.ts';

const withUpload = (...lines: string[]): string =>
  [
    'server: sftp://deploy@ssh.example.com/home/site',
    `password: ${ref('SEALUP_PASSWORD')}`,
    ...lines,
  ].join('\n');

describe('loadConfig: upload (decision 0022 §3)', () => {
  it('maps local folders to folders under the target folder, each with its place', async () => {
    const { result, folder, file } = await load(
      withUpload('upload:', '  public_html: www', '  api:', '    to: api/v1', '  static: .'),
    );
    const at = (line: number, keyPath: string) => ({ file, line, keyPath });
    expect(targetOf(result, 'ssh.example.com').uploads).toEqual([
      {
        kind: 'folder',
        local: join(folder, 'public_html'),
        remote: 'www',
        localFromConfig: 'public_html',
        place: at(4, 'upload.public_html'),
      },
      {
        kind: 'folder',
        local: join(folder, 'api'),
        remote: 'api/v1',
        localFromConfig: 'api',
        place: at(5, 'upload.api'),
      },
      {
        kind: 'folder',
        local: join(folder, 'static'),
        remote: '',
        localFromConfig: 'static',
        place: at(7, 'upload.static'),
      },
    ]);
  });

  it.each(['../up', '/abs', 'a/../b'])('refuses the server folder %s', async (remote) => {
    const { result } = await load(withUpload('upload:', `  public_html: "${remote}"`));
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'remote-path', line: 4, keyPath: 'upload.public_html' },
    ]);
  });

  it('takes mirror: true in the long form (spec #41 decision 29), on that mapping only', async () => {
    const { result } = await load(
      withUpload(
        'upload:',
        '  public_html:',
        '    to: www',
        '    mirror: true',
        '  api:',
        '    to: api',
        '    mirror: false',
        '  static: .',
      ),
    );
    const uploads = targetOf(result, 'ssh.example.com').uploads;
    expect(uploads.map((mapping) => mapping.mirror)).toEqual([true, undefined, undefined]);
  });

  it('refuses a mirror that is not true or false', async () => {
    const { result } = await load(
      withUpload('upload:', '  public_html:', '    to: www', '    mirror: always'),
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 6, keyPath: 'upload.public_html.mirror', expected: 'yes-no' },
    ]);
  });

  it('refuses an upload that is neither a folder nor a map', async () => {
    const { result } = await load(withUpload('upload: [dist]'));
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 3, keyPath: 'upload', expected: 'upload' },
    ]);
  });
});

describe('loadConfig: single files in upload (scope v1, spec #24 decision 23)', () => {
  it('maps a local file to a file path under the target folder, maybe renamed', async () => {
    const { result, folder, file } = await load(
      withUpload(
        'upload:',
        '  public_html: www',
        '  config/connect.prod.php: www/connect.php',
        '  server/htaccess.prod:',
        '    to: www/.htaccess',
      ),
      undefined,
      { 'config/connect.prod.php': '<?php', 'server/htaccess.prod': 'Deny' },
    );
    expect(targetOf(result, 'ssh.example.com').uploads.slice(1)).toEqual([
      {
        kind: 'file',
        local: join(folder, 'config', 'connect.prod.php'),
        remote: 'www/connect.php',
        localFromConfig: 'config/connect.prod.php',
        place: { file, line: 5, keyPath: 'upload.config/connect.prod.php' },
      },
      {
        kind: 'file',
        local: join(folder, 'server', 'htaccess.prod'),
        remote: 'www/.htaccess',
        localFromConfig: 'server/htaccess.prod',
        place: { file, line: 6, keyPath: 'upload.server/htaccess.prod' },
      },
    ]);
  });

  it.each(['.', '../connect.php', '/etc/passwd', 'www/'])(
    'refuses %s as the server side of a single file: a file path in the target folder (R10)',
    async (remote) => {
      const { result } = await load(
        withUpload('upload:', '  public_html: www', `  connect.prod.php: "${remote}"`),
        undefined,
        { 'connect.prod.php': '<?php' },
      );
      expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
        { code: 'remote-path', line: 5, keyPath: 'upload.connect.prod.php', detail: 'file' },
      ]);
    },
  );

  it('refuses a single file an exclude pattern matches, naming both lines (story 44)', async () => {
    const { result, file } = await load(
      [
        'upload:',
        '  public_html: www',
        '  api/.env.prod: api/.env',
        'exclude:',
        '  - public_html/resources',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
        '    exclude: [api/.env*]',
        '  staging:',
        '    server: sftp://deploy@ssh.example.com/home/staging',
        `    password: ${ref('SEALUP_PASSWORD')}`,
      ].join('\n'),
      undefined,
      { 'api/.env.prod': 'APP_ENV=production' },
    );
    expect(targetIssues(result, 'production')).toEqual([
      {
        code: 'excluded-file',
        file,
        line: 3,
        keyPath: 'upload.api/.env.prod',
        other: { file, line: 10, keyPath: 'targets.production.exclude.0' },
      },
    ]);
    expect(targetOf(result, 'staging').uploads.map((mapping) => mapping.kind)).toEqual([
      'folder',
      'file',
    ]);
  });

  it.each<[string[], string | undefined]>([
    [['README', '*.prod', 'api/'], 'exclude.1'],
    [['api/', '*.prod'], 'exclude.0'],
    [['*.prod', '!api/.env.prod'], undefined],
    [['*.prod', '!api/.env.prod', '.env*'], 'exclude.2'],
    [['api/.env.prod/'], undefined],
  ])('with exclude %j, names the pattern that leaves the file out: %s', async (list, keyPath) => {
    const { result } = await load(
      withUpload(
        'upload:',
        '  api/.env.prod: api/.env',
        'exclude:',
        ...list.map((pattern) => `  - "${pattern}"`),
      ),
      undefined,
      { 'api/.env.prod': 'APP_ENV=production' },
    );
    if (keyPath === undefined) {
      expect(targetOf(result, 'ssh.example.com').uploads).toHaveLength(1);
    } else {
      expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
        { code: 'excluded-file', line: 4, other: { keyPath } },
      ]);
    }
  });
});

describe('loadConfig: upload and exclude lists (decision 0022, ticket 06)', () => {
  const production = [
    '  production:',
    '    server: sftp://deploy@ssh.example.com:22/home/site',
    `    password: ${ref('SEALUP_PASSWORD')}`,
  ];

  it('reads `exclude` and the `local: remote` form of `upload` in the shorthand', async () => {
    const { result, folder } = await load(
      withUpload(
        'upload:',
        '  public_html: www',
        '  api: api',
        '  build/static: www/static',
        'exclude: [public_html/resources, api/storage, api/.env*]',
      ),
    );
    expect(targetOf(result, 'ssh.example.com')).toMatchObject({
      uploads: [
        { local: join(folder, 'public_html'), remote: 'www', localFromConfig: 'public_html' },
        { local: join(folder, 'api'), remote: 'api', localFromConfig: 'api' },
        {
          local: join(folder, 'build', 'static'),
          remote: 'www/static',
          localFromConfig: 'build/static',
        },
      ],
      exclude: ['public_html/resources', 'api/storage', 'api/.env*'],
    });
  });

  it("adds a target's own upload and exclude to the shared lists, for that target only", async () => {
    const { result, folder } = await load(
      [
        'upload:',
        '  public_html: www',
        'exclude:',
        '  - public_html/resources',
        'targets:',
        ...production,
        '    upload:',
        '      api: api',
        '    exclude: [public_html/admin]',
        '  staging:',
        '    server: sftp://deploy@ssh.example.com:22/home/staging',
        `    password: ${ref('SEALUP_PASSWORD')}`,
      ].join('\n'),
    );
    const shared = {
      local: join(folder, 'public_html'),
      remote: 'www',
      localFromConfig: 'public_html',
    };
    expect(targetOf(result, 'production')).toMatchObject({
      uploads: [shared, { local: join(folder, 'api'), remote: 'api', localFromConfig: 'api' }],
      exclude: ['public_html/resources', 'public_html/admin'],
    });
    expect(targetOf(result, 'staging')).toMatchObject({
      uploads: [shared],
      exclude: ['public_html/resources'],
    });
  });

  it('gives a source folder outside the config folder its ../ path', async () => {
    const { result } = await load(withUpload('upload: ../dist'));
    expect(targetOf(result, 'ssh.example.com').uploads).toMatchObject([
      { remote: '', localFromConfig: '../dist' },
    ]);
  });

  it('refuses a server side that leaves the target folder (R10), naming its place', async () => {
    const { result, file } = await load(withUpload('upload:', '  dist: ../etc'));
    expect(targetIssues(result, 'ssh.example.com')).toEqual([
      { code: 'remote-path', file, line: 4, keyPath: 'upload.dist' },
    ]);
  });

  it('refuses an exclude that is not a list of patterns', async () => {
    const { result } = await load(withUpload('upload: dist', 'exclude: {a: b}'));
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 4, keyPath: 'exclude', expected: 'patterns' },
    ]);
  });
});
