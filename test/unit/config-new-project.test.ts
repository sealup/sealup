// What `sealup init` writes through config (spec #24 decision 19): the password's line in
// sealup.env, read back by the env-file reader exactly as typed, and the minimal sealup.yml
// (exploration 06 §2.1), read back by the config loader.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  envSecret,
  hostKeyPlaceholder,
  loadConfig,
  newConfigText,
  withEnvVariable,
} from '../../src/config/index.ts';
import { redact } from '../../src/secret/index.ts';
import { canaries } from '../../src/testkit/index.ts';

const keyLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86';

/** The value made a Secret for sealup.env, then added to `text`. */
function withEnv(text: string, name: string, value: string, kind?: 'password' | 'file') {
  const made = envSecret(name, value, kind);
  return made.ok ? withEnvVariable(text, made.secret) : made;
}

describe('envSecret: a value bound for sealup.env is a Secret as soon as it is read', () => {
  it('prints as [secret] and is redacted from then on (R1)', () => {
    const value = 'fresh-pw-only-here-42';
    expect(redact(`x ${value} y`)).toBe(`x ${value} y`);
    const made = envSecret('SEALUP_PASSWORD', value);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(String(made.secret)).toBe('[secret]');
    expect(JSON.stringify({ made })).not.toContain(value);
    expect(redact(`x ${value} y`)).toBe('x [secret] y');
  });

  it('refuses a Secret config did not make for sealup.env', () => {
    const other = { envName: 'X', toString: () => '[secret]' };
    expect(() => withEnvVariable('', other as never)).toThrow(TypeError);
  });
});

describe('envSecret and withEnvVariable: the password into sealup.env', () => {
  it.each([
    ['the canary (both quotes, $, \\, %)', canaries.SEALUP_CANARY_PASSWORD],
    ['a #', 'pass#word'],
    ['a backtick and a quote', "it's`fine"],
    ['all three quotes', `a'b"c\`d`],
    ['a literal \\n', 'line\\nbreak'],
    [`a $\{…}`, `$\{HOME}pw`],
    ['plain letters', 'correct horse battery'],
  ])('writes %s so the env-file reader gives it back', (_, value) => {
    const edit = withEnv('', 'SEALUP_PASSWORD', value);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.added).toBe(true);
    expect(parseEnv(edit.text)).toEqual({ SEALUP_PASSWORD: value });
    expect(edit.text.endsWith('\n')).toBe(true);
  });

  it('appends to a file that holds other variables, keeping every byte of it', () => {
    const before = 'APP_ENV="one\ntwo"\r\nOTHER=x';
    const edit = withEnv(before, 'SEALUP_PASSWORD', 'secret-pw');
    expect(edit).toMatchObject({ ok: true, added: true });
    if (!edit.ok) return;
    expect(edit.text.startsWith(before)).toBe(true);
    expect(parseEnv(edit.text)).toEqual({
      APP_ENV: 'one\ntwo',
      OTHER: 'x',
      SEALUP_PASSWORD: 'secret-pw',
    });
  });

  it('leaves a file that already sets the variable as it is', () => {
    const before = 'SEALUP_PASSWORD=already-here\n';
    expect(withEnv(before, 'SEALUP_PASSWORD', 'another-pw')).toEqual({
      ok: true,
      added: false,
      text: before,
    });
  });

  it('fills a variable the file names with an empty value (the last line wins)', () => {
    const edit = withEnv('SEALUP_PASSWORD=\n', 'SEALUP_PASSWORD', 'secret-pw');
    expect(edit).toMatchObject({ ok: true, added: true });
    if (edit.ok) expect(parseEnv(edit.text).SEALUP_PASSWORD).toBe('secret-pw');
  });

  it.each([
    ['too-short', 'abc12'],
    ['surrounding-whitespace', ' padded-pw'],
    ['forbidden-character', 'two\nlines'],
    ['cannot-quote', `a'b"c\`d #e`],
  ])('refuses a value it cannot use or write: %s', (reason, value) => {
    expect(withEnv('', 'SEALUP_PASSWORD', value)).toEqual({ ok: false, reason });
  });

  // Decision 0045: the server and the host key of a public repository are not secrets.
  it('writes a plain value (the server, a host key) so the reader gives it back, never redacted', () => {
    const value = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnlyAPlainValue0045';
    const edit = withEnvVariable('SEALUP_PASSWORD=secret-pw\n', {
      envName: 'SEALUP_HOST_KEY',
      value,
    });
    expect(edit).toMatchObject({ ok: true, added: true });
    if (edit.ok) {
      expect(parseEnv(edit.text)).toEqual({ SEALUP_PASSWORD: 'secret-pw', SEALUP_HOST_KEY: value });
    }
    expect(redact(`x ${value} y`)).toBe(`x ${value} y`);
    const kept = withEnvVariable('SEALUP_SERVER=sftp://a@b/c\n', {
      envName: 'SEALUP_SERVER',
      value: 'sftp://other@host/www',
    });
    expect(kept).toEqual({ ok: true, added: false, text: 'SEALUP_SERVER=sftp://a@b/c\n' });
  });

  it("writes a file's content (the sam-sync conversion's .env) so the reader gives it back", () => {
    const content = 'APP_NAME="My App"\nAPP_KEY=base64:c2VjcmV0\nDB_PASSWORD=\'p#w\'\n';
    const edit = withEnv('SEALUP_PASSWORD=secret-pw\n', 'APP_ENV', content, 'file');
    expect(edit).toMatchObject({ ok: true, added: true });
    if (edit.ok) {
      expect(parseEnv(edit.text)).toEqual({ SEALUP_PASSWORD: 'secret-pw', APP_ENV: content });
    }
    expect(withEnv('', 'APP_ENV', content)).toEqual({
      ok: false,
      reason: 'forbidden-character',
    });
    expect(withEnv('', 'APP_ENV', 'A=1', 'file')).toEqual({
      ok: false,
      reason: 'too-short',
    });
    expect(withEnv('', 'APP_ENV', 'A=`x`\nB="y"\nC=\'z\'\n', 'file')).toEqual({
      ok: false,
      reason: 'cannot-quote',
    });
  });
});

describe('newConfigText: the minimal sealup.yml', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function load(text: string) {
    const folder = mkdtempSync(join(tmpdir(), 'sealup new config '));
    folders.push(folder);
    const file = join(folder, 'sealup.yml');
    writeFileSync(file, text);
    return loadConfig(file, { SEALUP_PASSWORD: 'secret-pw' });
  }

  it('is the four lines of exploration 06 §2.1', () => {
    const text = newConfigText({
      server: 'sftp://deploy@ssh.example.com/home/site/www',
      upload: 'dist',
      hostKey: keyLine,
    });
    expect(text).toBe(
      [
        'server: sftp://deploy@ssh.example.com/home/site/www',
        `password: $\{SEALUP_PASSWORD}`,
        `hostKey: ${keyLine}`,
        'upload: dist',
        '',
      ].join('\n'),
    );
  });

  it('holds the placeholder comment in place of the key that keyscan replaces', async () => {
    const text = newConfigText({
      server: 'sftp://deploy@ssh.example.com/home/site/www',
      upload: 'dist',
    });
    expect(text.split('\n')[2]).toBe(hostKeyPlaceholder);
    const loaded = await load(text);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const [entry] = loaded.config.targets.values();
    expect(entry?.hostKey).toBe('missing');
  });

  // Decision 0045: a public repository keeps the server and its host key out of sealup.yml.
  it('writes the server and the host key as references for a public repository, and loads them', async () => {
    const server = 'sftp://deploy@ssh.example.com/home/site/www';
    const text = newConfigText({ server, upload: 'dist', hostKey: keyLine, publicRepo: true });
    expect(text).toBe(
      [
        `server: $\{SEALUP_SERVER}`,
        `password: $\{SEALUP_PASSWORD}`,
        `hostKey: $\{SEALUP_HOST_KEY}`,
        'upload: dist',
        '',
      ].join('\n'),
    );
    const folder = mkdtempSync(join(tmpdir(), 'sealup new config '));
    folders.push(folder);
    const file = join(folder, 'sealup.yml');
    writeFileSync(file, text);
    const loaded = await loadConfig(file, {
      SEALUP_PASSWORD: 'secret-pw',
      SEALUP_SERVER: server,
      SEALUP_HOST_KEY: keyLine,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const [entry] = loaded.config.targets.values();
    expect(entry?.ok === true && entry.target.server.host).toBe('ssh.example.com');
    expect(entry?.hostKey).toBe('saved');
  });

  it('keeps the placeholder without a key, and no key line for FTP, for a public repository', () => {
    const sftp = newConfigText({
      server: 'sftp://deploy@ssh.example.com/www',
      upload: 'dist',
      publicRepo: true,
    });
    expect(sftp.split('\n').slice(0, 3)).toEqual([
      `server: $\{SEALUP_SERVER}`,
      `password: $\{SEALUP_PASSWORD}`,
      hostKeyPlaceholder,
    ]);
    const ftp = newConfigText({
      server: 'ftp://deploy@ftp.example.com/www',
      upload: 'dist',
      publicRepo: true,
    });
    expect(ftp).toBe(
      [`server: $\{SEALUP_SERVER}`, `password: $\{SEALUP_PASSWORD}`, 'upload: dist', ''].join('\n'),
    );
  });

  it('quotes a value YAML would read otherwise, and loads as written', async () => {
    const server = 'sftp://deploy@ssh.example.com/home/site #1';
    const upload = 'my build: out';
    const loaded = await load(newConfigText({ server, upload, hostKey: keyLine }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const [entry] = loaded.config.targets.values();
    expect(entry?.ok === true && entry.target.server.folder).toBe('/home/site #1');
  });
});
