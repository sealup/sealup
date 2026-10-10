// config: login with a private key (decision 0033, spec #41 decision 16). A target logs in with
// exactly one of `password` and `privateKey`, the key maybe with a `passphrase`; each takes one
// `${VAR}` (R3). The key keeps its line breaks (they are its format); the passphrase is a
// credential like a password (R4, R2). Problems carry a place, never a value (R6).

import { describe, expect, it } from 'vitest';
import { issuesOf, load, ref, targetIssues, targetOf } from '../config-kit.ts';

/** A key-shaped multi-line value: config never reads a key, it only holds it. */
const key = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBMGeYkJ0ZbFvXP2ktestonlyfixturenotarealkeyatall0000000000AAAA',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n');

const shorthand = (...login: string[]): string =>
  ['server: sftp://deploy@ssh.example.com/home/site', ...login, 'upload: dist', ''].join('\n');

describe('loadConfig: privateKey in place of password', () => {
  it('resolves a target that logs in with a key: no password, the key held as a Secret', async () => {
    const { result, file } = await load(shorthand(`privateKey: ${ref('DEPLOY_KEY')}`), {
      DEPLOY_KEY: key,
    });
    const target = targetOf(result, 'ssh.example.com');
    expect(target.password).toBeUndefined();
    expect(target.privateKey?.envName).toBe('DEPLOY_KEY');
    expect(String(target.privateKey)).toBe('[secret]');
    expect(target.passphrase).toBeUndefined();
    expect(target.places).toEqual({
      server: { file, line: 1, keyPath: 'server' },
      privateKey: { file, line: 2, keyPath: 'privateKey' },
      hostKey: undefined,
    });
    // Every Secret made while loading is there for GitHub's masks (R2).
    if (!result.ok) throw new Error('expected a config');
    expect(result.secrets).toContain(target.privateKey);
  });

  it('takes a passphrase for an encrypted key', async () => {
    const { result, file } = await load(
      shorthand(`privateKey: ${ref('DEPLOY_KEY')}`, `passphrase: ${ref('KEY_PASSPHRASE')}`),
      { DEPLOY_KEY: key, KEY_PASSPHRASE: 'correct horse' },
    );
    const target = targetOf(result, 'ssh.example.com');
    expect(target.passphrase?.envName).toBe('KEY_PASSPHRASE');
    expect(target.places.passphrase).toEqual({ file, line: 3, keyPath: 'passphrase' });
  });

  it('gives each target of a targets map its own way to log in', async () => {
    const { result } = await load(
      [
        'upload: dist',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('PROD_PASSWORD')}`,
        '  staging:',
        '    server: sftp://deploy@203.0.113.10/srv/site',
        `    privateKey: ${ref('STAGING_KEY')}`,
        '',
      ].join('\n'),
      { PROD_PASSWORD: 'pw-1234', STAGING_KEY: key },
    );
    expect(targetOf(result, 'production').password?.envName).toBe('PROD_PASSWORD');
    expect(targetOf(result, 'production').privateKey).toBeUndefined();
    expect(targetOf(result, 'staging').privateKey?.envName).toBe('STAGING_KEY');
    expect(targetOf(result, 'staging').password).toBeUndefined();
  });

  it('reads a key written over several lines in double quotes in sealup.env', async () => {
    const lines = key.trimEnd().split('\n');
    const { result } = await load(
      shorthand(`privateKey: ${ref('DEPLOY_KEY')}`),
      {},
      { 'sealup.env': `DEPLOY_KEY="${lines.join('\r\n')}"\r\nOTHER=x\r\n` },
    );
    expect(targetOf(result, 'ssh.example.com').privateKey?.envName).toBe('DEPLOY_KEY');
  });

  it('says where a key variable that is not set is read', async () => {
    const { result } = await load(shorthand(`privateKey: ${ref('DEPLOY_KEY')}`), {});
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'variable-not-set', line: 2, keyPath: 'privateKey', variable: 'DEPLOY_KEY' },
    ]);
  });
});

describe('loadConfig: exactly one way to log in (decision 0033)', () => {
  it('refuses a target with neither password nor privateKey, for every run', async () => {
    const { result } = await load(shorthand());
    expect(issuesOf(result)).toMatchObject([{ code: 'login', keyPath: '', detail: 'none' }]);
  });

  it('refuses a target with both, at the privateKey line', async () => {
    const { result } = await load(
      [
        'upload: dist',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('PROD_PASSWORD')}`,
        `    privateKey: ${ref('PROD_KEY')}`,
        '',
      ].join('\n'),
      { PROD_PASSWORD: 'pw-1234', PROD_KEY: key },
    );
    expect(issuesOf(result)).toMatchObject([
      {
        code: 'login',
        line: 6,
        keyPath: 'targets.production.privateKey',
        detail: 'both',
        other: { line: 5, keyPath: 'targets.production.password' },
      },
    ]);
  });

  it('refuses a passphrase without a privateKey', async () => {
    const { result } = await load(
      shorthand(`password: ${ref('SEALUP_PASSWORD')}`, `passphrase: ${ref('KEY_PASSPHRASE')}`),
      { SEALUP_PASSWORD: 'pw-1234', KEY_PASSPHRASE: 'correct horse' },
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'login', line: 3, keyPath: 'passphrase', detail: 'passphrase-alone' },
    ]);
  });

  it('refuses privateKey and passphrase at the top level next to targets:', async () => {
    const { result } = await load(
      [
        `privateKey: ${ref('KEY')}`,
        `passphrase: ${ref('PASS')}`,
        'upload: dist',
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('PROD_PASSWORD')}`,
        '',
      ].join('\n'),
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'shorthand-with-targets', line: 1, keyPath: 'privateKey' },
      { code: 'shorthand-with-targets', line: 2, keyPath: 'passphrase' },
    ]);
  });
});

describe('loadConfig: a key and its passphrase come from variables only (R3, R6)', () => {
  it('refuses a key written in the file, naming its place, never the value', async () => {
    const { result } = await load(
      shorthand(
        'privateKey: |',
        ...key
          .trimEnd()
          .split('\n')
          .map((line) => `  ${line}`),
      ),
    );
    const issues = issuesOf(result);
    expect(issues).toMatchObject([
      { code: 'secret-in-config', line: 2, keyPath: 'privateKey', detail: 'privateKey' },
    ]);
    expect(JSON.stringify(issues)).not.toContain('b3BlbnNz');
    // Written in the file, so it may be in the log's neighbourhood: masked all the same (R2).
    expect(result.secrets).toHaveLength(1);
  });

  it('refuses a passphrase written in the file', async () => {
    const { result } = await load(
      shorthand(`privateKey: ${ref('DEPLOY_KEY')}`, 'passphrase: correct-horse-literal'),
      { DEPLOY_KEY: key },
    );
    const issues = issuesOf(result);
    expect(issues).toMatchObject([
      { code: 'secret-in-config', line: 3, keyPath: 'passphrase', detail: 'passphrase' },
    ]);
    expect(JSON.stringify(issues)).not.toContain('correct-horse');
  });

  it('refuses a passphrase holding a line break (R4) or under 6 characters (R2)', async () => {
    const config = shorthand(
      `privateKey: ${ref('DEPLOY_KEY')}`,
      `passphrase: ${ref('KEY_PASSPHRASE')}`,
    );
    const broken = await load(config, { DEPLOY_KEY: key, KEY_PASSPHRASE: 'one-line\ntwo-line' });
    expect(targetIssues(broken.result, 'ssh.example.com')).toMatchObject([
      { code: 'secret-refused', line: 3, variable: 'KEY_PASSPHRASE', reason: 'unsafe-character' },
    ]);
    const short = await load(config, { DEPLOY_KEY: key, KEY_PASSPHRASE: 'abc12' });
    expect(targetIssues(short.result, 'ssh.example.com')).toMatchObject([
      { code: 'secret-refused', line: 3, variable: 'KEY_PASSPHRASE', reason: 'too-short' },
    ]);
  });

  it('refuses a key under 6 characters (R2)', async () => {
    const { result } = await load(shorthand(`privateKey: ${ref('DEPLOY_KEY')}`), {
      DEPLOY_KEY: 'abc',
    });
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'secret-refused', line: 2, variable: 'DEPLOY_KEY', reason: 'too-short' },
    ]);
  });
});
