// The sam-sync conversion (spec #24 decision 22, S03): a sam-sync `.deployment.json` (and its
// `.download.json`) in, sealup.yml's text out. The files are synthetic, written from sam-sync's
// own published package (sam-sync 1.1.1 on npm: index.js and .deployment.example.json): `host`,
// `user`, `password`, `port` (default 22), `type` (`sftp`, `ftp`, or absent for rsync over SSH),
// `localPrefix` and `remotePrefix` (each prefixed to an entry's path as text), `up` and `down`
// with `directories` (`source`, `destin` defaulting to `source`, rsync's `excludes`) and `files`,
// and `verbose` and `dry`.

import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { hostKeyPlaceholder, withEnvVariable } from '../../src/config/index.ts';
import {
  convertedConfigText,
  convertSamSync,
  type SamSyncConversion,
} from '../../src/init/index.ts';

const password = 'sam-sync-pw-123';

/** S03's two files (the CLI page's "Before: sam-sync"), with verbose and dry as the page says. */
const deployment = {
  type: 'sftp',
  host: 'ssh.example.com',
  port: 22,
  user: 'deploy',
  password,
  verbose: true,
  dry: false,
  localPrefix: './',
  remotePrefix: '/home/site/',
  up: {
    directories: [
      { source: 'public_html/', destin: 'www/', excludes: ['/resources'] },
      { source: 'api/', excludes: ['/.env', '/.env.prod', '/storage'] },
    ],
    files: [{ source: 'api/.env.prod', destin: 'api/.env' }],
  },
};
const download = {
  type: 'sftp',
  host: 'ssh.example.com',
  port: 22,
  user: 'deploy',
  password,
  localPrefix: './',
  remotePrefix: '/home/site/',
  down: { directories: [{ source: 'www/resources/', destin: 'public_html/resources/' }] },
};

function convert(deploy: unknown, down?: unknown, name = '.deployment.json'): SamSyncConversion {
  const result = convertSamSync({
    deployment: { name, text: JSON.stringify(deploy) },
    ...(down === undefined
      ? {}
      : { download: { name: '.download.json', text: JSON.stringify(down) } }),
  });
  if (!result.ok) throw new Error(`not converted: ${result.problem}`);
  return result.conversion;
}

describe('convertSamSync: S03', () => {
  it("turns S03's two files into one sealup.yml", () => {
    const conversion = convert(deployment, download);
    expect(convertedConfigText(conversion)).toBe(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: $\{SEALUP_PASSWORD}`,
        hostKeyPlaceholder,
        'upload:',
        '  public_html:',
        '    to: www',
        '    exclude:',
        '      - /resources',
        '  api:',
        '    to: api',
        '    exclude:',
        '      - /.env',
        '      - /.env.prod',
        '      - /storage',
        '  api/.env.prod: api/.env',
        'pull:',
        '  www/resources: public_html/resources',
        '',
      ].join('\n'),
    );
    // A Secret from the moment it is read (R1), whose line in sealup.env reads back as written.
    const made = conversion.password;
    expect(made?.ok).toBe(true);
    if (made?.ok === true) {
      expect(String(made.secret)).toBe('[secret]');
      const edit = withEnvVariable('', made.secret);
      expect(edit.ok && parseEnv(edit.text)).toEqual({ SEALUP_PASSWORD: password });
    }
    expect(conversion.envFiles).toEqual(['api/.env.prod']);
    expect(conversion.dropped).toEqual(['verbose', 'dry']);
    expect(conversion.download).toBe('same');
    expect(conversion.leftOut).toEqual([]);
  });

  it('puts the saved host key in place of the placeholder', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86';
    const text = convertedConfigText(convert(deployment), { hostKey: key });
    expect(text.split('\n')[2]).toBe(`hostKey: ${key}`);
  });
});

const minimal = { host: 'ssh.example.com', user: 'deploy', password, remotePrefix: '/home/site/' };

describe('convertSamSync: the server', () => {
  it.each([
    ['sftp', {}, 'sftp://deploy@ssh.example.com/home/site'],
    ['another port', { port: 2222 }, 'sftp://deploy@ssh.example.com:2222/home/site'],
    [
      'a prefix from the login folder',
      { remotePrefix: 'www/' },
      'sftp://deploy@ssh.example.com/~/www',
    ],
    ['a ~/ prefix', { remotePrefix: '~/www/' }, 'sftp://deploy@ssh.example.com/~/www'],
    ['no prefix: the login folder', { remotePrefix: undefined }, 'sftp://deploy@ssh.example.com/~'],
    ['the root', { remotePrefix: '/' }, 'sftp://deploy@ssh.example.com/'],
  ])('%s becomes an sftp:// URL', (_, extra, server) => {
    expect(convert({ ...minimal, type: 'sftp', ...extra }).server).toBe(server);
  });

  // rsync and scp over SSH (no type, or any other) need a shell: ssh:// sends one archive (0034).
  it.each([
    ['no type', {}, 'ssh://deploy@ssh.example.com/home/site'],
    ['rsync', { type: 'rsync' }, 'ssh://deploy@ssh.example.com/home/site'],
    ['another port', { port: 2222 }, 'ssh://deploy@ssh.example.com:2222/home/site'],
    [
      'a prefix from the login folder',
      { remotePrefix: 'www/' },
      'ssh://deploy@ssh.example.com/~/www',
    ],
  ])('rsync over SSH, %s, becomes an ssh:// URL', (_, extra, server) => {
    expect(convert({ ...minimal, ...extra }).server).toBe(server);
  });

  it('keeps sftp:// for rsync into a folder no command may hold (R15)', () => {
    expect(convert({ ...minimal, remotePrefix: '/home/my site/' }).server).toBe(
      'sftp://deploy@ssh.example.com/home/my site',
    );
  });

  // Plain FTP becomes ftp:// (spec #41 decision 18), on FTP's port 21 unless the file names
  // another; S23's warning comes on its first run.
  it.each([
    ['no port', {}, 'ftp://deploy@ssh.example.com/home/site'],
    ['port 21', { port: 21 }, 'ftp://deploy@ssh.example.com/home/site'],
    ['another port', { port: 2121 }, 'ftp://deploy@ssh.example.com:2121/home/site'],
    [
      'a prefix from the login folder',
      { remotePrefix: 'www/' },
      'ftp://deploy@ssh.example.com/~/www',
    ],
  ])('plain FTP, %s, becomes an ftp:// URL', (_, extra, server) => {
    expect(convert({ ...minimal, type: 'ftp', ...extra }).server).toBe(server);
  });

  it('writes no host key placeholder for plain FTP, which has none', () => {
    const text = convertedConfigText(convert({ ...deployment, type: 'ftp' }));
    expect(text).not.toContain('hostKey');
  });

  it.each([
    ['not JSON', '{ host: x'],
    ['a list', '[]'],
    ['no host', JSON.stringify({ user: 'deploy' })],
    ['no user', JSON.stringify({ host: 'ssh.example.com' })],
    ['a port as text', JSON.stringify({ ...minimal, port: '22' })],
    ['an entry without source', JSON.stringify({ ...minimal, up: { directories: [{}] } })],
    [
      'excludes not a list',
      JSON.stringify({ ...minimal, up: { directories: [{ source: 'a', excludes: '/b' }] } }),
    ],
  ])('cannot read %s, and names the file', (_, text) => {
    expect(convertSamSync({ deployment: { name: '.deployment.json', text } })).toEqual({
      ok: false,
      problem: 'unreadable',
      file: '.deployment.json',
    });
  });

  it('names .download.json when that is the one it cannot read', () => {
    const result = convertSamSync({
      deployment: { name: '.deployment.json', text: JSON.stringify(minimal) },
      download: { name: '.download.json', text: 'nope' },
    });
    expect(result).toEqual({ ok: false, problem: 'unreadable', file: '.download.json' });
  });

  it('keeps no password when the file has none', () => {
    const { password: _, ...none } = minimal;
    expect(convert(none).password).toBeUndefined();
  });
});

describe('convertSamSync: up', () => {
  it('retains repeated sources with each destination and its own directory exclusions', () => {
    const conversion = convert({
      ...minimal,
      up: {
        directories: [
          { source: 'api/', destin: 'main/api/', excludes: ['/.env*', '/storage'] },
          { source: 'api/', destin: 'designer/api/', excludes: ['/.env*', '/cache'] },
        ],
        files: [
          { source: 'api/.env.prod', destin: 'main/api/.env' },
          { source: 'api/.env.designer.prod', destin: 'designer/api/.env' },
        ],
      },
    });
    const document = parseDocument(convertedConfigText(conversion));
    expect(document.errors).toEqual([]);
    expect(document.toJS()).toMatchObject({
      server: 'ssh://deploy@ssh.example.com/home/site',
      upload: {
        api: [
          { to: 'main/api', exclude: ['/.env*', '/storage'] },
          { to: 'designer/api', exclude: ['/.env*', '/cache'] },
        ],
        'api/.env.prod': 'main/api/.env',
        'api/.env.designer.prod': 'designer/api/.env',
      },
    });
    expect(document.toJS()).not.toHaveProperty('write');
    expect(document.toJS()).not.toHaveProperty('exclude');
    expect(conversion.leftOut).toEqual([]);
  });

  it('consolidates only exact redundant uploads and retains changed exclusion behavior', () => {
    const conversion = convert({
      ...minimal,
      up: {
        directories: [
          { source: 'api/', destin: 'api/', excludes: ['/storage'] },
          { source: 'api/', destin: 'api/', excludes: ['/storage'] },
          { source: 'api/', destin: 'api/', excludes: ['/cache'] },
        ],
        files: [
          { source: 'api/.env.prod', destin: 'api/.env' },
          { source: 'api/.env.prod', destin: 'designer/.env' },
        ],
      },
    });
    expect(conversion.upload).toHaveLength(4);
    expect(conversion.leftOut).toEqual([{ from: 'api/', to: 'api/', reason: 'twice' }]);
    expect(parseDocument(convertedConfigText(conversion)).toJS().upload).toEqual({
      api: [
        { to: 'api', exclude: ['/storage'] },
        { to: 'api', exclude: ['/cache'] },
      ],
      'api/.env.prod': ['api/.env', 'designer/.env'],
    });
    expect(conversion.envFiles).toEqual(['api/.env.prod']);
  });

  it('refuses control characters in local env-source paths before adding Git ignore rules', () => {
    const conversion = convert({
      ...minimal,
      up: { files: [{ source: 'api/.env\n!sealup.env', destin: 'api/.env' }] },
    });
    expect(conversion.upload).toEqual([]);
    expect(conversion.envFiles).toEqual([]);
    expect(conversion.leftOut).toEqual([
      { from: 'api/.env\n!sealup.env', to: 'api/.env', reason: 'outside' },
    ]);
  });

  it("keeps rsync's excludes scoped to the source folder", () => {
    const conversion = convert({
      ...minimal,
      up: {
        directories: [
          {
            source: 'dist/',
            destin: 'www/',
            excludes: ['/uploads', 'cache', 'tmp/', '/a/b', '*.log'],
          },
        ],
      },
    });
    expect(conversion.upload[0]?.exclude).toEqual([
      '/uploads',
      '**/cache',
      '**/tmp/',
      '/a/b',
      '**/*.log',
    ]);
  });

  it('puts the prefixes in front of each path as text, as sam-sync does', () => {
    const conversion = convert({
      ...minimal,
      localPrefix: 'app/',
      remotePrefix: '/home/site',
      up: { directories: [{ source: 'dist/', destin: 'www/' }] },
    });
    expect(conversion.server).toBe('ssh://deploy@ssh.example.com/home');
    expect(conversion.upload).toEqual([{ local: 'app/dist', remote: 'sitewww', kind: 'folder' }]);
  });

  it('reads local paths from the folder of the sam-sync file', () => {
    const conversion = convert(
      { ...minimal, localPrefix: './', up: { directories: [{ source: 'dist/', destin: 'www/' }] } },
      undefined,
      'front/.deployment.json',
    );
    expect(conversion.upload).toEqual([{ local: 'front/dist', remote: 'www', kind: 'folder' }]);
  });

  it('sends a folder to the target folder itself as `.`', () => {
    const conversion = convert({
      ...minimal,
      up: { directories: [{ source: 'dist/', destin: '' }] },
    });
    expect(convertedConfigText(conversion)).toContain('upload:\n  dist: .\n');
  });

  it('turns every single file into a direct upload, recording env source paths to ignore', () => {
    const conversion = convert({
      ...minimal,
      up: {
        files: [
          { source: 'server/htaccess.prod', destin: 'www/.htaccess' },
          { source: 'robots.txt' },
          { source: 'api/.env.prod', destin: 'api/.env' },
          { source: 'admin/.env' },
        ],
      },
    });
    expect(conversion.upload).toEqual([
      { local: 'server/htaccess.prod', remote: 'www/.htaccess', kind: 'file' },
      { local: 'robots.txt', remote: 'robots.txt', kind: 'file' },
      { local: 'api/.env.prod', remote: 'api/.env', kind: 'file' },
      { local: 'admin/.env', remote: 'admin/.env', kind: 'file' },
    ]);
    expect(conversion.envFiles).toEqual(['api/.env.prod', 'admin/.env']);
    expect(convertedConfigText(conversion)).toContain(
      '  api/.env.prod: api/.env\n  admin/.env: admin/.env\n',
    );
  });

  it('leaves out what sealup.yml cannot hold, and says why', () => {
    const conversion = convert({
      ...minimal,
      up: {
        directories: [
          { source: './' },
          { source: '../shared/', destin: 'shared/' },
          { source: 'dist/', destin: '../elsewhere/' },
          { source: 'api/', excludes: ['/connect.prod.php'] },
          { source: 'api/', destin: 'api2/' },
        ],
        files: [{ source: 'api/connect.prod.php', destin: 'api/connect.php' }],
      },
    });
    expect(conversion.upload).toEqual([
      { local: 'api', remote: 'api', kind: 'folder', exclude: ['/connect.prod.php'] },
      { local: 'api', remote: 'api2', kind: 'folder' },
      { local: 'api/connect.prod.php', remote: 'api/connect.php', kind: 'file' },
    ]);
    expect(conversion.leftOut).toEqual([
      { from: './', to: './', reason: 'project-folder' },
      { from: '../shared/', to: 'shared/', reason: 'outside' },
      { from: 'dist/', to: '../elsewhere/', reason: 'outside' },
    ]);
  });

  // R10, segment by segment: `..x` is a name inside the folder, not a climb out of it.
  it('keeps a folder whose name starts with two dots, on either side', () => {
    const conversion = convert({
      ...minimal,
      up: { directories: [{ source: '..build/', destin: '..x/' }] },
    });
    expect(conversion.upload).toEqual([{ local: '..build', remote: '..x', kind: 'folder' }]);
    expect(conversion.leftOut).toEqual([]);
  });

  it('drops verbose and dry, only those the files set', () => {
    expect(convert({ ...minimal, dry: true }).dropped).toEqual(['dry']);
    expect(convert(minimal).dropped).toEqual([]);
  });
});

describe('convertSamSync: down', () => {
  it('reports repeated pull sources rather than overwriting the first destination in YAML', () => {
    const conversion = convert({
      ...minimal,
      down: {
        directories: [
          { source: 'www/resources/', destin: 'public/resources/' },
          { source: 'www/resources/', destin: 'backup/resources/' },
        ],
      },
    });
    expect(conversion.pull).toEqual([
      { remote: 'www/resources', local: 'public/resources', kind: 'folder' },
    ]);
    expect(conversion.leftOut).toEqual([
      { from: 'www/resources/', to: 'backup/resources/', reason: 'twice' },
    ]);
    expect(parseDocument(convertedConfigText(conversion)).toJS().pull).toEqual({
      'www/resources': 'public/resources',
    });
  });
  it('turns down entries of either file into pull entries, folders and files', () => {
    const conversion = convert(
      {
        ...minimal,
        down: { files: [{ source: 'www/sitemap.xml', destin: 'public/sitemap.xml' }] },
      },
      {
        ...minimal,
        remotePrefix: '/home/site/www/',
        down: {
          directories: [{ source: 'uploads/', destin: 'public/uploads/', excludes: ['/tmp'] }],
        },
      },
    );
    expect(conversion.download).toBe('same');
    expect(conversion.pull).toEqual([
      { remote: 'www/sitemap.xml', local: 'public/sitemap.xml', kind: 'file' },
      { remote: 'www/uploads', local: 'public/uploads', kind: 'folder' },
    ]);
    expect(conversion.pullExcludes).toEqual(['/tmp']);
  });

  it('skips a .download.json on another server, and says so', () => {
    const conversion = convert(minimal, {
      ...minimal,
      host: 'other.example.com',
      down: { directories: [{ source: 'www/uploads/', destin: 'public/uploads/' }] },
    });
    expect(conversion.download).toBe('other');
    expect(conversion.pull).toEqual([]);
  });

  it('leaves out a pull into the project folder, or from outside the target folder', () => {
    const conversion = convert(minimal, {
      ...minimal,
      down: {
        directories: [
          { source: 'www/', destin: './' },
          { source: '../other/', destin: 'other/' },
        ],
      },
    });
    expect(conversion.pull).toEqual([]);
    expect(conversion.leftOut).toEqual([
      { from: 'www/', to: './', reason: 'project-folder' },
      { from: '../other/', to: 'other/', reason: 'outside' },
    ]);
  });
});

describe('convertedConfigText', () => {
  it('quotes a value YAML would read otherwise, and reads back as written', () => {
    const conversion = convert({
      ...minimal,
      up: {
        directories: [{ source: 'my site: v2/', destin: '#www/', excludes: ['/*.bak', '!keep'] }],
      },
      down: { directories: [{ source: 'yes/', destin: 'true/' }] },
    });
    const read = parseDocument(convertedConfigText(conversion)).toJS();
    expect(read).toMatchObject({
      upload: { 'my site: v2': { to: '#www', exclude: ['/*.bak', '**/!keep'] } },
      pull: { yes: 'true' },
    });
  });
});
