// config for `ftps://` (R8, spec #41 decisions 4, 8, 10): explicit TLS on port 21 unless the URL
// names one, FTP's connections, a password login only, and `tlsFingerprint`, the pinned
// certificate's SHA-256, at its place when it is not one.

import { describe, expect, it } from 'vitest';
import { load, ref, targetIssues, targetOf } from '../config-kit.ts';

// OpenSSL's SHA-256 of the test-only self-signed certificate (testkit's tls-certificates.ts).
const sha256 =
  'FE:F7:2D:37:AE:E6:22:4C:86:16:C1:E5:80:EC:21:04:16:85:E7:97:78:0C:8E:B4:25:B4:56:E4:98:D1:75:10';

const ftps = (...more: string[]): string =>
  [
    'server: ftps://deploy@ftp.example.com/www',
    `password: ${ref('SEALUP_PASSWORD')}`,
    'upload: dist',
    ...more,
  ].join('\n');

describe('loadConfig: an ftps:// server', () => {
  it('is FTP over explicit TLS on port 21, with 4 connections and no host key', async () => {
    const target = targetOf((await load(ftps())).result, 'ftp.example.com');
    expect(target.server).toEqual({
      protocol: 'ftps',
      user: 'deploy',
      host: 'ftp.example.com',
      port: 21,
      folder: '/www',
    });
    expect(target.parallel).toBe(4);
    expect(target.hostKey).toBeUndefined();
    expect(target.tlsFingerprint).toBeUndefined();
  });

  it('keeps the port the URL names', async () => {
    const { result } = await load(ftps().replace('ftp.example.com/', 'ftp.example.com:2121/'));
    expect(targetOf(result, 'ftp.example.com').server.port).toBe(2121);
  });

  it('takes up to 16 connections, and names the line past that', async () => {
    const { result } = await load(ftps('parallel: 17'));
    expect(targetIssues(result, 'ftp.example.com')).toMatchObject([
      { code: 'wrong-type', line: 4, keyPath: 'parallel', expected: 'connections' },
    ]);
  });

  it('refuses a privateKey: FTPS logs in with a password', async () => {
    const { result } = await load(
      [
        'server: ftps://deploy@ftp.example.com/www',
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

describe('loadConfig: tlsFingerprint', () => {
  it('pins the certificate, its place kept for the words', async () => {
    const target = targetOf(
      (await load(ftps(`tlsFingerprint: ${sha256}`))).result,
      'ftp.example.com',
    );
    expect(target.tlsFingerprint).toBe(sha256);
    expect(target.places.tlsFingerprint).toMatchObject({ line: 4, keyPath: 'tlsFingerprint' });
  });

  it('takes lowercase hex, kept in uppercase as certificates are compared', async () => {
    const { result } = await load(ftps(`tlsFingerprint: ${sha256.toLowerCase()}`));
    expect(targetOf(result, 'ftp.example.com').tlsFingerprint).toBe(sha256);
  });

  it('reads a variable', async () => {
    const { result } = await load(ftps(`tlsFingerprint: ${ref('FTPS_PIN')}`), {
      SEALUP_PASSWORD: 'pw-1234',
      FTPS_PIN: sha256,
    });
    expect(targetOf(result, 'ftp.example.com').tlsFingerprint).toBe(sha256);
  });

  it.each([
    ['too short', sha256.slice(0, -3)],
    ['no colons', sha256.replaceAll(':', '')],
    ['not hex', sha256.replace('FE', 'FG')],
    ['an OpenSSH fingerprint', 'SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM'],
  ])('refuses one %s at its line', async (_, value) => {
    const { result } = await load(ftps(`tlsFingerprint: '${value}'`));
    expect(targetIssues(result, 'ftp.example.com')).toMatchObject([
      { code: 'wrong-type', line: 4, keyPath: 'tlsFingerprint', expected: 'fingerprint' },
    ]);
  });

  it('is not read for another protocol, as hostKey is not for ftp://', async () => {
    const { result } = await load(
      [
        'server: sftp://deploy@ssh.example.com/home/site',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: dist',
        `tlsFingerprint: ${sha256}`,
      ].join('\n'),
    );
    expect(targetOf(result, 'ssh.example.com').tlsFingerprint).toBeUndefined();
  });
});
