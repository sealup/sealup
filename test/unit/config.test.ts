// config (tickets 04 and 09, decision 0022): the one-target shorthand and the `targets:` map,
// `server` as one URL, `password` only as `${VAR}`, `${VAR}` / `${VAR:?message}` / `$$` after
// parsing on strings only, the tune keys and their defaults, keys this version cannot honour,
// and every problem at its place (file, line, key path), never with a value.
//
// Problems with the file itself stop every run; problems that depend on the environment or on
// this version's limits belong to one target, so they stop only a run to that target.

// `upload` and `exclude` are in config-uploads.test.ts.

import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { issuesOf, load, ref, targetIssues, targetOf, tempFolder } from '../config-kit.ts';

// A real ed25519 public key line; its fingerprint below is what `ssh-keygen -lf` prints for it
// (and the one on the CLI page's goldens).
const hostKeyLine =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86';
const fingerprint = 'SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM';

const shorthand = (...more: string[]): string =>
  [
    'server: sftp://deploy@ssh.example.com/home/site',
    `password: ${ref('SEALUP_PASSWORD')}`,
    'upload: dist',
    ...more,
  ].join('\n');

describe('loadConfig: the one-target shorthand', () => {
  it('resolves the four-line config into one target named after the host', async () => {
    const { result, folder, file } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site/www',
        `password: ${ref('SEALUP_PASSWORD')}`,
        `hostKey: ${hostKeyLine}`,
        'upload: dist',
        '',
      ].join('\n'),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.config.file).toBe(file);
    expect([...result.config.targets.keys()]).toEqual(['ssh.example.com']);
    const target = targetOf(result, 'ssh.example.com');
    expect(target).toMatchObject({
      name: 'ssh.example.com',
      server: {
        protocol: 'sftp',
        user: 'deploy',
        host: 'ssh.example.com',
        port: 22,
        folder: '/home/site/www',
      },
      hostKey: { type: 'ssh-ed25519', fingerprint },
      url: undefined,
      uploads: [{ local: join(folder, 'dist'), remote: '', localFromConfig: 'dist' }],
      exclude: [],
      parallel: 64,
      timeoutMs: 30_000,
      manifestFolder: '/~/.sealup',
      allow: new Set(),
      places: {
        server: { file, line: 1, keyPath: 'server' },
        password: { file, line: 2, keyPath: 'password' },
        hostKey: { file, line: 3, keyPath: 'hostKey' },
      },
    });
    expect(target.password?.envName).toBe('SEALUP_PASSWORD');
    expect(String(target.password)).toBe('[secret]');
  });

  it('reads a port, a folder relative to the login folder, and the site url', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com:2222/~/staging/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: public_html',
        'url: https://example.com',
      ].join('\n'),
    );
    const target = targetOf(result, 'ssh.example.com');
    expect(target.server).toMatchObject({ port: 2222, folder: '/~/staging/site' });
    expect(target.hostKey).toBeUndefined();
    expect(target.places.hostKey).toBeUndefined();
    expect(target.url).toBe('https://example.com');
  });
});

describe('loadConfig: a targets map', () => {
  const twoTargets = [
    'upload: public_html',
    'targets:',
    '  production:',
    '    server: sftp://deploy@ssh.example.com:22/home/site',
    `    password: ${ref('PROD_PASSWORD')}`,
    `    hostKey: ${hostKeyLine}`,
    '    url: https://example.com',
    '  staging:',
    '    server: sftp://deploy@staging.example.com/home/site',
    `    password: ${ref('STAGING_PASSWORD')}`,
  ].join('\n');

  it('names each target, in file order, and shares the top-level upload', async () => {
    const { result, folder } = await load(twoTargets, {
      PROD_PASSWORD: 'pw-5678',
      STAGING_PASSWORD: 'pw-9012',
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect([...result.config.targets.keys()]).toEqual(['production', 'staging']);
    expect(targetOf(result, 'production')).toMatchObject({
      name: 'production',
      uploads: [{ local: join(folder, 'public_html'), remote: '', localFromConfig: 'public_html' }],
      url: 'https://example.com',
    });
    expect(targetOf(result, 'staging').server.host).toBe('staging.example.com');
  });

  it("keeps one target's unset variable to that target: the others still resolve", async () => {
    const { result, file } = await load(twoTargets, { PROD_PASSWORD: 'pw-5678' });
    expect(targetOf(result, 'production').name).toBe('production');
    expect(targetIssues(result, 'staging')).toEqual([
      {
        code: 'variable-not-set',
        file,
        line: 10,
        keyPath: 'targets.staging.password',
        variable: 'STAGING_PASSWORD',
        envFile: join(dirname(file), 'sealup.env'),
      },
    ]);
  });

  it('refuses the shorthand keys at the top level next to targets:', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        'upload: dist',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
      ].join('\n'),
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'shorthand-with-targets', line: 1, keyPath: 'server' },
    ]);
  });

  it('refuses target names a command line could not carry', async () => {
    const { result } = await load(
      [
        'upload: dist',
        'targets:',
        '  "my site":',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
      ].join('\n'),
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 3, keyPath: 'targets.my site', expected: 'target-name' },
    ]);
  });

  it('refuses an empty targets map', async () => {
    const { result } = await load(['upload: dist', 'targets: {}'].join('\n'));
    expect(issuesOf(result)).toMatchObject([{ code: 'no-targets', line: 2, keyPath: 'targets' }]);
  });
});

describe('loadConfig: variables (decision 0022 §6)', () => {
  it(`fills $\{VAR} in any string, the server URL included (R23)`, async () => {
    const { result } = await load(
      [
        `server: sftp://${ref('SITE_USER')}@${ref('SITE_HOST')}/home/${ref('SITE_USER')}/www`,
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: dist',
      ].join('\n'),
      { SEALUP_PASSWORD: 'pw-for-tests', SITE_USER: 'deploy', SITE_HOST: 'ssh.example.com' },
    );
    expect(targetOf(result, 'ssh.example.com').server).toMatchObject({
      user: 'deploy',
      host: 'ssh.example.com',
      folder: '/home/deploy/www',
    });
  });

  it('reads $$ as one literal $', async () => {
    const { result } = await load(shorthand('url: https://example.com/$$shop'));
    expect(targetOf(result, 'ssh.example.com').url).toBe('https://example.com/$shop');
  });

  it(`stops with the message of $\{VAR:?message} when the variable is unset or empty`, async () => {
    const { result, file } = await load(
      shorthand(`url: https://${ref('SITE:?add SITE to sealup.env')}`),
      { SEALUP_PASSWORD: 'pw-for-tests', SITE: '' },
    );
    expect(targetIssues(result, 'ssh.example.com')).toEqual([
      {
        code: 'variable-not-set',
        file,
        line: 4,
        keyPath: 'url',
        variable: 'SITE',
        message: 'add SITE to sealup.env',
        envFile: join(dirname(file), 'sealup.env'),
      },
    ]);
  });

  it(`takes the password from $\{VAR:?message} too`, async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('P:?set P')}`,
        'upload: dist',
      ].join('\n'),
      { P: 'pw-1234' },
    );
    expect(targetOf(result, 'ssh.example.com').password?.envName).toBe('P');
  });

  it.each([
    ['$NAME', 'https://example.com/$SITE'],
    ['a lone $', 'https://example.com/$'],
    [`$\{VAR:-default}`, `https://example.com/$\{SITE:-x}`],
    ['an unclosed ${', `https://example.com/$\{SITE`],
  ])('refuses %s, at its place', async (_, url) => {
    const { result } = await load(shorthand(`url: ${url}`));
    expect(issuesOf(result)).toMatchObject([{ code: 'variable-syntax', line: 4, keyPath: 'url' }]);
  });

  it('never parses a value as YAML: a variable cannot add a key', async () => {
    const { result } = await load(shorthand(`url: ${ref('SITE')}`), {
      SEALUP_PASSWORD: 'pw-for-tests',
      SITE: 'https://example.com\nparallel: 1',
    });
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'site-url', keyPath: 'url' },
    ]);
  });

  it('leaves numbers and keys alone: interpolation is on string values only', async () => {
    const { result } = await load(shorthand('parallel: 8'));
    expect(targetOf(result, 'ssh.example.com').parallel).toBe(8);
  });
});

describe('loadConfig: tune keys (decision 0022 §8)', () => {
  const named = (shared: string[], own: string[]): string =>
    [
      'upload: dist',
      ...shared,
      'targets:',
      '  production:',
      '    server: sftp://deploy@ssh.example.com/home/site',
      `    password: ${ref('SEALUP_PASSWORD')}`,
      ...own.map((line) => `    ${line}`),
      '  staging:',
      '    server: sftp://deploy@ssh.example.com/home/staging',
      `    password: ${ref('SEALUP_PASSWORD')}`,
    ].join('\n');

  it('has defaults: 64 in flight, 30 s per operation, .sealup in the login folder', async () => {
    const { result } = await load(named([], []));
    expect(targetOf(result, 'staging')).toMatchObject({
      parallel: 64,
      timeoutMs: 30_000,
      manifestFolder: '/~/.sealup',
      url: undefined,
      allow: new Set(),
      checkServer: false,
    });
  });

  it('applies top-level tune keys to every target; a target can set its own', async () => {
    const { result } = await load(
      named(
        ['parallel: 16', 'timeout: 2m', 'manifest: private/.sealup'],
        ['parallel: 8', 'timeout: 45s', 'manifest: /home/deploy/.sealup-prod'],
      ),
    );
    expect(targetOf(result, 'production')).toMatchObject({
      parallel: 8,
      timeoutMs: 45_000,
      manifestFolder: '/home/deploy/.sealup-prod',
    });
    expect(targetOf(result, 'staging')).toMatchObject({
      parallel: 16,
      timeoutMs: 120_000,
      manifestFolder: '/~/private/.sealup',
    });
  });

  it('keeps a manifest folder written from the login folder with /~/', async () => {
    const { result } = await load(shorthand('manifest: /~/staging/.sealup'));
    expect(targetOf(result, 'ssh.example.com').manifestFolder).toBe('/~/staging/.sealup');
  });

  it('turns a safety net off with allow: [empty-source]', async () => {
    const { result } = await load(named([], ['allow: [empty-source]']));
    expect(targetOf(result, 'production').allow).toEqual(new Set(['empty-source']));
  });

  it.each([
    ['parallel: 0', 'parallel', 'count'],
    ['parallel: 300', 'parallel', 'count'],
    ['parallel: 1.5', 'parallel', 'count'],
    ['timeout: 30', 'timeout', 'duration'],
    ['timeout: 30 s', 'timeout', 'duration'],
    ['timeout: 1h', 'timeout', 'duration'],
    ['allow: empty-source', 'allow', 'allow'],
    ['allow: [everything]', 'allow.0', 'allow'],
  ])('refuses %s, saying what the key takes', async (line, keyPath, expected) => {
    const { result } = await load(shorthand(line));
    expect(issuesOf(result)).toMatchObject([{ code: 'wrong-type', line: 4, keyPath, expected }]);
  });

  it.each(['../outside', 'a//b', '/'])('refuses the manifest folder %s', async (folder) => {
    const { result } = await load(shorthand(`manifest: "${folder}"`));
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'bad-path', line: 4, keyPath: 'manifest' },
    ]);
  });

  it.each(['example.com', 'ftp://example.com', 'https://exa mple.com'])(
    'refuses the site url %s',
    async (url) => {
      const { result } = await load(shorthand(`url: ${url}`));
      expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
        { code: 'site-url', line: 4, keyPath: 'url' },
      ]);
    },
  );
});

describe('loadConfig: what this version cannot honour stops, never ignored (story 51)', () => {
  it('reads an ssh:// server: SFTP plus a shell, for the archive (spec #41 decision 13)', async () => {
    const { result } = await load(
      [
        'server: ssh://deploy@ssh.example.com:2222/~/www',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: dist',
      ].join('\n'),
    );
    expect(targetOf(result, 'ssh.example.com').server).toEqual({
      protocol: 'ssh',
      user: 'deploy',
      host: 'ssh.example.com',
      port: 2222,
      folder: '/~/www',
    });
  });

  // R15: only the target root goes in the archive's command, inside a strict character set.
  it.each([
    ['a space', 'ssh://deploy@ssh.example.com/home/my site'],
    ['a quote', "ssh://deploy@ssh.example.com/home/it's"],
    ['a dollar', 'ssh://deploy@ssh.example.com/~/$$(touch pwned)'],
    ['a non-ASCII letter', 'ssh://deploy@ssh.example.com/home/café'],
  ])('refuses an ssh:// folder with %s, which sftp:// takes', async (_, url) => {
    const lines = (server: string) =>
      [`server: ${server}`, `password: ${ref('SEALUP_PASSWORD')}`, 'upload: dist'].join('\n');
    const { result } = await load(lines(url));
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'server-url', line: 1, keyPath: 'server' },
    ]);
    const sftp = await load(lines(url.replace('ssh://', 'sftp://')));
    expect(targetOf(sftp.result, 'ssh.example.com').server.protocol).toBe('sftp');
  });

  // Spec #41 decisions 4 and 10: plain FTP, port 21, `parallel` counts connections (4, at most
  // 16), no host key, a password only.
  describe('ftp://', () => {
    const ftp = (...more: string[]) =>
      [
        'server: ftp://deploy@ftp.example.com/www',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: dist',
        ...more,
      ].join('\n');

    it('takes an ftp:// server on port 21, 4 connections, with no host key', async () => {
      const { result } = await load(ftp());
      const target = targetOf(result, 'ftp.example.com');
      expect(target.server).toEqual({
        protocol: 'ftp',
        user: 'deploy',
        host: 'ftp.example.com',
        port: 21,
        folder: '/www',
      });
      expect(target.parallel).toBe(4);
      expect(target.hostKey).toBeUndefined();
    });

    it('takes up to 16 connections, and names the line past that', async () => {
      expect(targetOf((await load(ftp('parallel: 16'))).result, 'ftp.example.com').parallel).toBe(
        16,
      );
      const { result } = await load(ftp('parallel: 17'));
      expect(targetIssues(result, 'ftp.example.com')).toMatchObject([
        { code: 'wrong-type', line: 4, keyPath: 'parallel', expected: 'connections' },
      ]);
    });

    it('refuses a shared parallel past 16 for an ftp:// target only', async () => {
      const { result } = await load(
        [
          'upload: dist',
          'parallel: 64',
          'targets:',
          '  production:',
          '    server: sftp://deploy@ssh.example.com/home/site',
          `    password: ${ref('SEALUP_PASSWORD')}`,
          '  old:',
          '    server: ftp://deploy@ftp.example.com/www',
          `    password: ${ref('SEALUP_PASSWORD')}`,
        ].join('\n'),
      );
      expect(targetOf(result, 'production').parallel).toBe(64);
      expect(targetIssues(result, 'old')).toMatchObject([
        { code: 'wrong-type', line: 2, keyPath: 'parallel', expected: 'connections' },
      ]);
    });

    it('refuses a privateKey: plain FTP logs in with a password', async () => {
      const { result } = await load(
        [
          'server: ftp://deploy@ftp.example.com:2121/www',
          `privateKey: ${ref('DEPLOY_KEY')}`,
          'upload: dist',
        ].join('\n'),
        { DEPLOY_KEY: 'a-key-long-enough' },
      );
      expect(targetIssues(result, 'ftp.example.com')).toMatchObject([
        { code: 'login', line: 2, keyPath: 'privateKey', detail: 'ftp-key' },
      ]);
    });
  });

  it('takes allow: [root-folder] (decision 0029)', async () => {
    const { result } = await load(shorthand('allow: [empty-source, root-folder]'));
    expect([...targetOf(result, 'ssh.example.com').allow]).toEqual(['empty-source', 'root-folder']);
  });

  it('takes allow: [symlinks] (spec #41 decision 28)', async () => {
    const { result } = await load(shorthand('allow: [empty-source, symlinks]'));
    expect([...targetOf(result, 'ssh.example.com').allow]).toEqual(['empty-source', 'symlinks']);
  });
});

describe('loadConfig: problems carry a place, never a value (R3, R6)', () => {
  it.each([
    ['a literal', 'hunter2-literal'],
    ['a literal around a variable', `hunter2-${ref('P')}`],
    ['a literal $', 'hunter2-$$'],
  ])('refuses %s password, naming the key and line, not the value', async (_, password) => {
    const { result, file } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${password}`,
        'upload: dist',
      ].join('\n'),
      { P: 'x' },
    );
    const issues = issuesOf(result);
    expect(issues).toEqual([{ code: 'secret-in-config', file, line: 2, keyPath: 'password' }]);
    expect(JSON.stringify(issues)).not.toContain('hunter2');
  });

  it('refuses a literal password in any target: it is in git already', async () => {
    const { result } = await load(
      [
        'upload: dist',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('P')}`,
        '  staging:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        '    password: hunter2-literal',
      ].join('\n'),
      { P: 'x' },
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'secret-in-config', line: 8, keyPath: 'targets.staging.password' },
    ]);
  });

  it('names an unset or empty variable and its place', async () => {
    const { result, file } = await load(
      [
        'upload: dist',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('PROD_PASSWORD')}`,
      ].join('\n'),
      { PROD_PASSWORD: '' },
    );
    expect(targetIssues(result, 'production')).toEqual([
      {
        code: 'variable-not-set',
        file,
        line: 5,
        keyPath: 'targets.production.password',
        variable: 'PROD_PASSWORD',
        envFile: join(dirname(file), 'sealup.env'),
      },
    ]);
  });

  it('refuses a password holding a line break (R4), naming only the variable', async () => {
    const { result, file } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('P')}`,
        'upload: dist',
      ].join('\n'),
      { P: 'line-one\nline-two' },
    );
    expect(targetIssues(result, 'ssh.example.com')).toEqual([
      {
        code: 'secret-refused',
        file,
        line: 2,
        keyPath: 'password',
        variable: 'P',
        reason: 'unsafe-character',
      },
    ]);
  });

  it('refuses a password under 6 characters (R2), naming only the variable', async () => {
    const config = [
      'server: sftp://deploy@ssh.example.com/home/site',
      `password: ${ref('P')}`,
      'upload: dist',
    ].join('\n');
    const short = await load(config, { P: 'abc12' });
    expect(targetIssues(short.result, 'ssh.example.com')).toEqual([
      {
        code: 'secret-refused',
        file: short.file,
        line: 2,
        keyPath: 'password',
        variable: 'P',
        reason: 'too-short',
      },
    ]);
    const enough = await load(config, { P: 'abc123' });
    expect(targetOf(enough.result, 'ssh.example.com').password?.envName).toBe('P');
  });

  it('refuses duplicate keys, with the line', async () => {
    const { result } = await load(
      ['server: sftp://a@example.com/x', 'upload: dist', 'upload: build'].join('\n'),
    );
    expect(issuesOf(result)).toMatchObject([{ code: 'yaml', line: 3 }]);
  });

  it('refuses a key it does not know, never ignoring it', async () => {
    const { result } = await load(shorthand('mirorr: true'));
    expect(issuesOf(result)).toMatchObject([{ code: 'unknown-key', line: 4, keyPath: 'mirorr' }]);
  });

  it('says what is missing', async () => {
    const { result } = await load('server: sftp://deploy@ssh.example.com/home/site\n');
    // No way to log in: password or privateKey (decision 0033).
    expect(issuesOf(result)).toMatchObject([
      { code: 'missing-key', keyPath: 'upload' },
      { code: 'login', keyPath: '', detail: 'none' },
    ]);
  });

  it('refuses a file that is not a mapping of keys', async () => {
    const { result } = await load('- server\n- upload\n');
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', keyPath: '', expected: 'mapping' },
    ]);
  });

  it.each([
    ['no scheme', 'deploy@ssh.example.com/home/site'],
    ['no user', 'sftp://ssh.example.com/home/site'],
    ['no folder', 'sftp://deploy@ssh.example.com'],
    ['a relative-looking folder', 'sftp://deploy@ssh.example.com/home/../etc'],
    ['a password in the URL', 'sftp://deploy:pw@ssh.example.com/home/site'],
    ['a port out of range', 'sftp://deploy@ssh.example.com:70000/home/site'],
  ])('refuses a server URL with %s', async (_, url) => {
    const { result } = await load(
      [`server: ${url}`, `password: ${ref('SEALUP_PASSWORD')}`, 'upload: dist'].join('\n'),
    );
    const issues = targetIssues(result, 'ssh.example.com');
    expect(issues).toMatchObject([{ code: 'server-url', line: 1, keyPath: 'server' }]);
    expect(JSON.stringify(issues)).not.toContain(':pw@');
  });

  it('refuses a host key that is not one OpenSSH public key line', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'hostKey: SHA256:FfL0Hs0QWkS6WvgKqyfJ3cH8xx3rjOWPcoHZcx',
        'upload: dist',
      ].join('\n'),
    );
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'host-key', line: 3, keyPath: 'hostKey' },
    ]);
  });

  it('says when the file is missing', async () => {
    const file = join(tempFolder(), 'sealup.yml');
    expect(await loadConfig(file, {})).toEqual({
      ok: false,
      issues: [{ code: 'file-not-found', file, keyPath: '' }],
      secrets: [],
      hidden: [],
    });
  });
});

describe('loadConfig: checkServer (spec #41 decision 26)', () => {
  it('is off by default and on with checkServer: true', async () => {
    const off = await load(shorthand());
    expect(targetOf(off.result, 'ssh.example.com').checkServer).toBe(false);
    const on = await load(shorthand('checkServer: true'));
    expect(targetOf(on.result, 'ssh.example.com').checkServer).toBe(true);
  });

  it('refuses a value other than true or false', async () => {
    const { result } = await load(shorthand('checkServer: yes'));
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 4, keyPath: 'checkServer', expected: 'yes-no' },
    ]);
  });

  it('belongs to a target: at the top level of a targets map it is refused', async () => {
    const { result } = await load(
      [
        'checkServer: true',
        'upload: dist',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
      ].join('\n'),
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'shorthand-with-targets', line: 1, keyPath: 'checkServer' },
    ]);
  });
});
