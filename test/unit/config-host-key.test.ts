// config, saving a host key into sealup.yml as text (spec #24 decision 18, story 20): one line
// added after the target's `server:` line (or the old `hostKey:` line replaced, or init's
// placeholder comment), with the target's indentation; every other byte stays; the file parsed
// again gives that key. On the shorthand and on named targets.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hostKeyPlaceholder,
  keyVariable,
  loadConfig,
  readKeyVariable,
  saveHostKey,
  saveTlsFingerprint,
  withHostKey,
  withTlsFingerprint,
} from '../../src/config/index.ts';
import { ref, targetOf, tempFolder } from '../config-kit.ts';

/** The CLI page's key (S04), and another one (the page's staging key). */
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86';
const other = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIMytt7XOtQoLfxloYx9nFD1pYMdoQ6Dwr6b8D+pHN8R';

const lines = (...text: string[]): string => text.join('\n');

describe('withHostKey: the shorthand', () => {
  it("adds the line after server:, with server:'s indentation, every other byte equal", () => {
    const before = lines(
      '# my site',
      'server: sftp://deploy@ssh.example.com/home/site/www   # the host panel says so',
      `password: ${ref('SEALUP_PASSWORD')}`,
      'upload: dist',
      '',
    );
    expect(withHostKey(before, 'ssh.example.com', key)).toEqual({
      ok: true,
      line: 3,
      text: lines(
        '# my site',
        'server: sftp://deploy@ssh.example.com/home/site/www   # the host panel says so',
        `hostKey: ${key}`,
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: dist',
        '',
      ),
    });
  });

  it('replaces the old hostKey: value, keeping the comment after it', () => {
    const before = lines(
      'server: sftp://deploy@ssh.example.com/home/site/www',
      `password: ${ref('SEALUP_PASSWORD')}`,
      `hostKey: ${other}   # from the panel`,
      'upload: dist',
    );
    expect(withHostKey(before, 'ssh.example.com', key)).toEqual({
      ok: true,
      line: 3,
      text: lines(
        'server: sftp://deploy@ssh.example.com/home/site/www',
        `password: ${ref('SEALUP_PASSWORD')}`,
        `hostKey: ${key}   # from the panel`,
        'upload: dist',
      ),
    });
  });

  it("replaces init's placeholder comment, where init put it", () => {
    const before = lines(
      'server: sftp://deploy@ssh.example.com/home/site/www',
      `password: ${ref('SEALUP_PASSWORD')}`,
      hostKeyPlaceholder,
      'upload: dist',
      '',
    );
    expect(withHostKey(before, 'ssh.example.com', key)).toEqual({
      ok: true,
      line: 3,
      text: lines(
        'server: sftp://deploy@ssh.example.com/home/site/www',
        `password: ${ref('SEALUP_PASSWORD')}`,
        `hostKey: ${key}`,
        'upload: dist',
        '',
      ),
    });
  });

  it("leaves a person's own hostKey comment as it is, and adds the line after server:", () => {
    const before = lines(
      'server: sftp://deploy@ssh.example.com/home/site/www',
      '# hostKey: ask the host for it',
      'upload: dist',
    );
    const after = withHostKey(before, 'ssh.example.com', key);
    expect(after).toMatchObject({ ok: true, line: 2 });
    expect(after.ok && after.text).toBe(
      lines(
        'server: sftp://deploy@ssh.example.com/home/site/www',
        `hostKey: ${key}`,
        '# hostKey: ask the host for it',
        'upload: dist',
      ),
    );
  });

  it('keeps CRLF line breaks, and a last line with no line break', () => {
    const before = ['upload: dist', 'server: sftp://deploy@ssh.example.com/home/site'].join('\r\n');
    expect(withHostKey(before, 'ssh.example.com', key)).toEqual({
      ok: true,
      line: 3,
      text: [
        'upload: dist',
        'server: sftp://deploy@ssh.example.com/home/site',
        `hostKey: ${key}`,
      ].join('\r\n'),
    });
  });
});

describe('withHostKey: named targets', () => {
  const config = (production: string[], staging: string[]): string =>
    lines(
      'upload: dist',
      'targets:',
      '  production:',
      ...production,
      '  staging:   # the test site',
      ...staging,
      '',
    );
  const production = [
    '    server: sftp://deploy@ssh.example.com/home/site',
    `    password: ${ref('PROD_PASSWORD')}`,
  ];
  const staging = [
    '    server: sftp://deploy@203.0.113.10/srv/site',
    `    password: ${ref('STAGING_PASSWORD')}`,
  ];

  it("adds the line to that target only, after its server:, with the target's indentation", () => {
    expect(withHostKey(config(production, staging), 'staging', key)).toEqual({
      ok: true,
      line: 8,
      text: config(production, [staging[0] ?? '', `    hostKey: ${key}`, staging[1] ?? '']),
    });
  });

  it("replaces that target's old key, not another target's", () => {
    const before = config(
      [...production, `    hostKey: ${other}`],
      [...staging, `    hostKey: ${other}`],
    );
    expect(withHostKey(before, 'production', key)).toEqual({
      ok: true,
      line: 6,
      text: config([...production, `    hostKey: ${key}`], [...staging, `    hostKey: ${other}`]),
    });
  });

  it("replaces init's placeholder in that target's block only", () => {
    const placeholder = `    ${hostKeyPlaceholder}`;
    const before = config([...production, placeholder], [...staging, placeholder]);
    expect(withHostKey(before, 'staging', key)).toEqual({
      ok: true,
      line: 10,
      text: config([...production, placeholder], [...staging, `    hostKey: ${key}`]),
    });
  });

  it('refuses a target written on one line ({ … }): it cannot add a line there', () => {
    const before = lines(
      'upload: dist',
      'targets:',
      '  production: { server: sftp://deploy@ssh.example.com/home/site, password: x }',
    );
    expect(withHostKey(before, 'production', key)).toEqual({ ok: false });
  });

  it('refuses a target that is not in the file', () => {
    expect(withHostKey(config(production, staging), 'preview', key)).toEqual({ ok: false });
  });
});

describe('saveHostKey', () => {
  it('writes the file, which loads again with that key; it says on which line', async () => {
    const folder = tempFolder();
    const file = join(folder, 'sealup.yml');
    const before = lines(
      'upload: dist',
      'server: sftp://deploy@ssh.example.com/home/site/www',
      `password: ${ref('SEALUP_PASSWORD')}`,
      '',
    );
    writeFileSync(file, before);
    expect(await saveHostKey(file, 'ssh.example.com', key)).toEqual({ ok: true, line: 3 });
    expect(readFileSync(file, 'utf8')).toBe(
      lines(
        'upload: dist',
        'server: sftp://deploy@ssh.example.com/home/site/www',
        `hostKey: ${key}`,
        `password: ${ref('SEALUP_PASSWORD')}`,
        '',
      ),
    );
    const loaded = await loadConfig(file, { SEALUP_PASSWORD: 'pw-1234' });
    expect(targetOf(loaded, 'ssh.example.com').hostKey).toEqual({
      type: 'ssh-ed25519',
      key: key.split(' ')[1],
      fingerprint: 'SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM',
    });
  });

  it('leaves a file it cannot edit as it was', async () => {
    const folder = tempFolder();
    const file = join(folder, 'sealup.yml');
    const before = 'targets:\n  production: { server: sftp://deploy@ssh.example.com/srv }\n';
    writeFileSync(file, before);
    expect(await saveHostKey(file, 'production', key)).toEqual({ ok: false });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

// Spec #41 decision 12: keyscan pins an `ftps://` certificate as one line, as it saves a key.
describe('withTlsFingerprint and saveTlsFingerprint', () => {
  const sha256 =
    'FE:F7:2D:37:AE:E6:22:4C:86:16:C1:E5:80:EC:21:04:16:85:E7:97:78:0C:8E:B4:25:B4:56:E4:98:D1:75:10';
  const old = sha256.replace('FE:F7', '00:11');

  it("adds the line after a named target's server:, every other byte equal", () => {
    const before = lines(
      'upload: dist',
      'targets:',
      '  legacy:',
      '    server: ftps://deploy@ftp.example.com/www',
      `    password: ${ref('FTP_PASSWORD')}`,
      '',
    );
    expect(withTlsFingerprint(before, 'legacy', sha256)).toEqual({
      ok: true,
      line: 5,
      text: lines(
        'upload: dist',
        'targets:',
        '  legacy:',
        '    server: ftps://deploy@ftp.example.com/www',
        `    tlsFingerprint: ${sha256}`,
        `    password: ${ref('FTP_PASSWORD')}`,
        '',
      ),
    });
  });

  it("replaces the old pin, a comment after it kept, and never touches init's hostKey comment", () => {
    const before = lines(
      'server: ftps://deploy@ftp.example.com/www',
      hostKeyPlaceholder,
      `tlsFingerprint: ${old}   # from the host panel`,
      `password: ${ref('FTP_PASSWORD')}`,
    );
    const edit = withTlsFingerprint(before, 'ftp.example.com', sha256);
    expect(edit).toMatchObject({ ok: true, line: 3 });
    expect(edit.ok && edit.text).toBe(
      lines(
        'server: ftps://deploy@ftp.example.com/www',
        hostKeyPlaceholder,
        `tlsFingerprint: ${sha256}   # from the host panel`,
        `password: ${ref('FTP_PASSWORD')}`,
      ),
    );
  });

  it("saves a pin that config then reads as the target's tlsFingerprint", async () => {
    const folder = tempFolder();
    const file = join(folder, 'sealup.yml');
    writeFileSync(
      file,
      lines('server: ftps://deploy@ftp.example.com/www', `password: ${ref('P')}`, 'upload: dist'),
    );
    expect(await saveTlsFingerprint(file, 'ftp.example.com', sha256)).toEqual({
      ok: true,
      line: 2,
    });
    const loaded = await loadConfig(file, { P: 'pw-1234' });
    expect(targetOf(loaded, 'ftp.example.com').tlsFingerprint).toBe(sha256);
  });
});

// Plan 06 spec #88 decision 8 (decision 0045 point 7): a key or pin read from a `${NAME}` is the
// person's to update, in sealup.env and in CI; no save ever writes over it.
describe('a hostKey or tlsFingerprint read from a variable', () => {
  const sha256 =
    'FE:F7:2D:37:AE:E6:22:4C:86:16:C1:E5:80:EC:21:04:16:85:E7:97:78:0C:8E:B4:25:B4:56:E4:98:D1:75:10';
  const shorthand = lines(
    'server: sftp://deploy@ssh.example.com/home/site/www',
    `hostKey: ${ref('SEALUP_HOST_KEY')}   # in sealup.env and in CI`,
    `password: ${ref('SEALUP_PASSWORD')}`,
    '',
  );
  const named = lines(
    'targets:',
    '  production:',
    `    server: ${ref('SEALUP_SERVER')}`,
    `    hostKey: ${ref('SEALUP_HOST_KEY:?set it in sealup.env')}`,
    `    password: ${ref('SEALUP_PASSWORD')}`,
    '  legacy:',
    '    server: ftps://deploy@ftp.example.com/www',
    `    tlsFingerprint: ${ref('SEALUP_TLS_FINGERPRINT')}`,
    `    password: ${ref('FTP_PASSWORD')}`,
    '  staging:',
    '    server: sftp://deploy@203.0.113.10/srv',
    `    hostKey: ${other}`,
    `    password: ${ref('STAGING_PASSWORD')}`,
    '',
  );

  it('names the variable, on the shorthand and on named targets', () => {
    expect(keyVariable(shorthand, 'ssh.example.com', 'hostKey')).toBe('SEALUP_HOST_KEY');
    expect(keyVariable(named, 'production', 'hostKey')).toBe('SEALUP_HOST_KEY');
    expect(keyVariable(named, 'legacy', 'tlsFingerprint')).toBe('SEALUP_TLS_FINGERPRINT');
  });

  it('names none for a literal, a missing key, `$$`, or a target not in the file', () => {
    expect(keyVariable(named, 'staging', 'hostKey')).toBeUndefined();
    expect(keyVariable(named, 'legacy', 'hostKey')).toBeUndefined();
    expect(keyVariable(named, 'preview', 'hostKey')).toBeUndefined();
    expect(keyVariable('server: sftp://h/x\nhostKey: a$${B}\n', 'h', 'hostKey')).toBeUndefined();
    expect(keyVariable('server: [', 'h', 'hostKey')).toBeUndefined();
  });

  it('names a variable read inside a longer value too: that value is never replaced either', () => {
    const text = `server: sftp://h/x\nhostKey: ssh-ed25519 ${ref('KEY_BLOB')}\n`;
    expect(keyVariable(text, 'h', 'hostKey')).toBe('KEY_BLOB');
    expect(withHostKey(text, 'h', key)).toEqual({ ok: false, variable: 'KEY_BLOB' });
  });

  it('withHostKey and withTlsFingerprint refuse to write over it, naming the variable', () => {
    expect(withHostKey(shorthand, 'ssh.example.com', key)).toEqual({
      ok: false,
      variable: 'SEALUP_HOST_KEY',
    });
    expect(withHostKey(named, 'production', key)).toEqual({
      ok: false,
      variable: 'SEALUP_HOST_KEY',
    });
    expect(withTlsFingerprint(named, 'legacy', sha256)).toEqual({
      ok: false,
      variable: 'SEALUP_TLS_FINGERPRINT',
    });
  });

  it("still replaces another target's literal key in the same file", () => {
    const edit = withHostKey(named, 'staging', key);
    expect(edit).toMatchObject({ ok: true, line: 12 });
    expect(edit.ok && edit.text).toBe(named.replace(`hostKey: ${other}`, `hostKey: ${key}`));
  });

  it('saveHostKey and saveTlsFingerprint leave the file byte for byte, naming the variable', async () => {
    const folder = tempFolder();
    const file = join(folder, 'sealup.yml');
    writeFileSync(file, named);
    expect(await saveHostKey(file, 'production', key)).toEqual({
      ok: false,
      variable: 'SEALUP_HOST_KEY',
    });
    expect(await saveTlsFingerprint(file, 'legacy', sha256)).toEqual({
      ok: false,
      variable: 'SEALUP_TLS_FINGERPRINT',
    });
    expect(readFileSync(file, 'utf8')).toBe(named);
    expect(await readKeyVariable(file, 'production', 'hostKey')).toBe('SEALUP_HOST_KEY');
  });
});
