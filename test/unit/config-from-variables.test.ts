// config for a public repository (decision 0045): a server, host key or certificate fingerprint
// whose whole value is one `${NAME}` reference. The resolved target says which parts came from a
// variable and the variable's name; the target's facts say it even when the variable is unset
// (keyscan --save must never write over a reference); and their values are the `hidden` values
// GitHub's form masks, never secrets that a terminal would redact.

import { describe, expect, it } from 'vitest';
import type { ConfigResult } from '../../src/config/index.ts';
import { load, ref, targetOf } from '../config-kit.ts';

const hostKeyLine =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86';
const fingerprint = 'SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM';
const sha256 =
  'FE:F7:2D:37:AE:E6:22:4C:86:16:C1:E5:80:EC:21:04:16:85:E7:97:78:0C:8E:B4:25:B4:56:E4:98:D1:75:10';

const hiddenSftp = [
  'upload: dist',
  'targets:',
  '  production:',
  `    server: ${ref('SEALUP_SERVER')}`,
  `    password: ${ref('SEALUP_PASSWORD')}`,
  `    hostKey: ${ref('SEALUP_HOST_KEY')}`,
].join('\n');

const env = {
  SEALUP_PASSWORD: 'pw-1234',
  SEALUP_SERVER: 'sftp://hidden-user@hidden-host.example.com/home/site',
  SEALUP_HOST_KEY: hostKeyLine,
};

function entryOf(result: ConfigResult, name: string) {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const entry = result.config.targets.get(name);
  if (entry === undefined) throw new Error(`no target ${name}`);
  return entry;
}

describe('loadConfig: parts read from a variable (decision 0045)', () => {
  it('names the variable of a server and a host key written as one reference', async () => {
    const { result } = await load(hiddenSftp, env);
    const target = targetOf(result, 'production');
    expect(target.fromVariables).toEqual({ server: 'SEALUP_SERVER', hostKey: 'SEALUP_HOST_KEY' });
    expect(target.server.host).toBe('hidden-host.example.com');
  });

  it('takes the `:?message` form as a reference too', async () => {
    const yaml = hiddenSftp.replace(ref('SEALUP_SERVER'), `"${ref('SEALUP_SERVER:?set it')}"`);
    const target = targetOf((await load(yaml, env)).result, 'production');
    expect(target.fromVariables).toEqual({ server: 'SEALUP_SERVER', hostKey: 'SEALUP_HOST_KEY' });
  });

  it('has none for a server in plain text, or a variable inside other text', async () => {
    const plain = [
      'server: sftp://deploy@ssh.example.com/home/site',
      `password: ${ref('SEALUP_PASSWORD')}`,
      `hostKey: ${hostKeyLine}`,
      'upload: dist',
    ].join('\n');
    const inside = plain.replace('ssh.example.com', ref('SEALUP_HOST'));
    const plainResult = (await load(plain)).result;
    const insideResult = (await load(inside, { ...env, SEALUP_HOST: 'ssh.example.com' })).result;
    expect(targetOf(plainResult, 'ssh.example.com').fromVariables).toBeUndefined();
    expect(targetOf(insideResult, 'ssh.example.com').fromVariables).toBeUndefined();
    expect(entryOf(plainResult, 'ssh.example.com').fromVariables).toBeUndefined();
    expect(plainResult.hidden).toEqual([]);
    expect(insideResult.hidden).toEqual([]);
  });

  it('tells it in the facts of a target whose variables are not set (keyscan --save)', async () => {
    const { result } = await load(hiddenSftp, { SEALUP_PASSWORD: 'pw-1234' });
    const entry = entryOf(result, 'production');
    expect(entry.ok).toBe(false);
    expect(entry.fromVariables).toEqual({ server: 'SEALUP_SERVER', hostKey: 'SEALUP_HOST_KEY' });
    expect(result.hidden).toEqual([]);
  });

  it('hides the server, its user and host, the key line and its fingerprint', async () => {
    const { result } = await load(hiddenSftp, env);
    expect(result.hidden).toEqual([
      'sftp://hidden-user@hidden-host.example.com/home/site',
      'hidden-user',
      'hidden-host.example.com',
      hostKeyLine,
      fingerprint,
    ]);
  });

  it('hides the key as the variable holds it, a comment included, and as a line', async () => {
    const { result } = await load(hiddenSftp, {
      ...env,
      SEALUP_HOST_KEY: `${hostKeyLine} root@web-1`,
    });
    expect(result.hidden).toEqual(
      expect.arrayContaining([`${hostKeyLine} root@web-1`, hostKeyLine, fingerprint]),
    );
  });

  it('hides them for every target, one that cannot be used included', async () => {
    const yaml = [
      hiddenSftp,
      '  staging:',
      `    server: ${ref('STAGING_SERVER')}`,
      `    password: ${ref('STAGING_PASSWORD')}`,
    ].join('\n');
    const { result } = await load(yaml, {
      ...env,
      STAGING_SERVER: 'sftp://staging-user@staging-host.example.com/srv',
    });
    expect(entryOf(result, 'staging').ok).toBe(false);
    expect(result.hidden).toEqual(
      expect.arrayContaining(['staging-user', 'staging-host.example.com']),
    );
  });

  it('names and hides an FTPS certificate fingerprint read from a variable', async () => {
    const yaml = [
      `server: ${ref('SEALUP_SERVER')}`,
      `password: ${ref('SEALUP_PASSWORD')}`,
      `tlsFingerprint: ${ref('SEALUP_TLS_FINGERPRINT')}`,
      'upload: dist',
    ].join('\n');
    const { result } = await load(yaml, {
      SEALUP_PASSWORD: 'pw-1234',
      SEALUP_SERVER: 'ftps://ftp-user@ftp-host.example.com/www',
      SEALUP_TLS_FINGERPRINT: sha256.toLowerCase(),
    });
    const target = targetOf(result, 'ftp-host.example.com');
    expect(target.fromVariables).toEqual({
      server: 'SEALUP_SERVER',
      tlsFingerprint: 'SEALUP_TLS_FINGERPRINT',
    });
    expect(result.hidden).toEqual([
      'ftps://ftp-user@ftp-host.example.com/www',
      'ftp-user',
      'ftp-host.example.com',
      sha256.toLowerCase(),
      sha256,
    ]);
  });

  it('never makes them secrets: a terminal still shows them (R22)', async () => {
    const { result } = await load(hiddenSftp, env);
    expect(result.secrets.map((secret) => secret.envName)).toEqual(['SEALUP_PASSWORD']);
  });
});
