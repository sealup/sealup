// `ftps://` through main() and the in-process FTPS server (R8, spec #41 decisions 8, 10; plan 05
// T04): the target block shows the certificate, a certificate not trusted or a refused AUTH TLS
// stops with exit 4 before the user name is sent, and pull reads an FTPS server.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScanCertificate } from '../../src/contracts/index.ts';
import {
  canaries,
  createFtpServer,
  type FtpServer,
  screenOf,
  testCertificates,
  testServerKey,
} from '../../src/testkit/index.ts';
import { scanCertificate } from '../../src/transport/index.ts';
import { createProject, inGitHub, newProject, ref, runMain, versionLine } from '../deploy-kit.ts';
import { dialing } from '../sftp-kit.ts';

const { selfSigned, trusted } = testCertificates;

const servers: FtpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function ftpsServer(tls = true): Promise<FtpServer> {
  const server = await createFtpServer({
    password: canaries.SEALUP_CANARY_PASSWORD,
    ...(tls ? { tls: { key: testServerKey, cert: selfSigned.pem } } : {}),
  });
  servers.push(server);
  return server;
}

/** An `ftps://` target, the server on line 4; `pin` on line 6 when given. */
const ftpsConfig = (pin?: string, ...more: string[]): string =>
  [
    'upload: public_html',
    'targets:',
    '  production:',
    '    server: ftps://deploy@ftp.example.com/www',
    `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
    ...(pin === undefined ? [] : [`    tlsFingerprint: ${pin}`]),
    '    url: https://example.com',
    ...more,
    '',
  ].join('\n');

const sentUser = (server: FtpServer): boolean =>
  server.commands().some((command) => /^(USER|PASS)\b/.test(command));

async function deploy(
  server: FtpServer,
  pin?: string,
  options: { json?: boolean; env?: Readonly<Record<string, string>> } = {},
) {
  const project = createProject(ftpsConfig(pin), { 'public_html/index.html': '<h1>home</h1>' });
  return runMain(['deploy', 'production', ...(options.json === true ? ['--json'] : [])], {
    cwd: project.root,
    connect: dialing(server),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

describe('deploy over ftps:// with tlsFingerprint', () => {
  it('shows the pinned certificate in the target block, no plain-FTP warning, and deploys', async () => {
    const server = await ftpsServer();
    const run = await deploy(server, selfSigned.sha256);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      [
        '  production  ftps://deploy@ftp.example.com:21/www',
        '  host key    certificate CN=sealup test FTP server  pinned',
        `              SHA-256 ${selfSigned.sha256}`,
        '',
      ].join('\n'),
    );
    expect(run.stderr).not.toContain('Plain FTP');
    expect(new TextDecoder().decode(server.files().get('/www/index.html')?.bytes)).toBe(
      '<h1>home</h1>',
    );
    expect(new Set(server.dataTls())).toEqual(new Set(['resumed']));
  });

  it('stops with exit 4 before the user name when the server shows another certificate', async () => {
    const server = await ftpsServer();
    const run = await deploy(server, trusted.sha256);
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain(
      [
        '  host key    certificate CN=sealup test FTP server  refused',
        `              SHA-256 ${selfSigned.sha256}`,
        '',
        "  ✗ The server's TLS certificate changed. sealup stopped before logging in.",
        '    sealup.yml (line 6) pins one certificate; ftp.example.com showed another:',
        `      expected  SHA-256 ${trusted.sha256}`,
        `      received  SHA-256 ${selfSigned.sha256}`,
        '    Either your host renewed or replaced its certificate, or someone between',
        '    you and the server is intercepting the connection.',
        "    Ask your host for the certificate's SHA-256. If it is the received one:",
        '      sealup keyscan production   then commit sealup.yml.',
        '',
        '    The password was not sent. Nothing was changed on production.',
        '    More: sealup.dev/e/certificate-refused',
      ].join('\n'),
    );
    expect(sentUser(server)).toBe(false);
  });
});

describe('deploy over ftps:// without tlsFingerprint', () => {
  it('stops with exit 4 before the user name on a certificate no CA vouches for', async () => {
    const server = await ftpsServer();
    const run = await deploy(server);
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain(
      [
        '  host key    certificate CN=sealup test FTP server  refused',
        `              SHA-256 ${selfSigned.sha256}`,
        '',
        "  ✗ The server's TLS certificate is not trusted. sealup stopped before logging in.",
        '    The TLS certificate is signed by no known authority, or is out of date.',
        '      subject  CN=sealup test FTP server',
        '      issuer   CN=sealup test FTP server',
        '      valid    2026-10-09 to 2126-09-15',
        `      SHA-256  ${selfSigned.sha256}`,
        '    If your host confirms this certificate (ask for its SHA-256), pin it:',
        '      sealup keyscan production   then commit sealup.yml.',
        '',
        '    The password was not sent. Nothing was changed on production.',
        '    More: sealup.dev/e/certificate-refused',
      ].join('\n'),
    );
    expect(sentUser(server)).toBe(false);
  });

  it('says so in --json: exit 4, the certificate-refused slug', async () => {
    const server = await ftpsServer();
    const run = await deploy(server, undefined, { json: true });
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'failed',
      exitCode: 4,
      error: { code: 'certificate-refused' },
    });
  });

  it('puts the stop in a GitHub annotation and the job summary', async () => {
    const server = await ftpsServer();
    const run = await deploy(server, undefined, { env: inGitHub });
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain(
      '::error file=sealup.yml,line=4,title=TLS certificate not trusted::',
    );
    expect(run.summary).toContain('certificate');
    expect(run.summary).toContain(selfSigned.sha256);
  });
});

describe('deploy over ftps:// to a server that refuses AUTH TLS (R8)', () => {
  it('stops with exit 4 before the user name, never falling back to plain FTP', async () => {
    const server = await ftpsServer(false);
    const run = await deploy(server, selfSigned.sha256);
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain(
      [
        '  host key    not checked',
        '',
        '  ✗ ftp.example.com refused TLS. sealup stopped before logging in.',
        '    The server refused TLS (AUTH TLS): Command not implemented.',
        '    sealup never falls back to plain FTP. Check the port in server',
        '    (sealup.yml line 4): FTPS here is explicit TLS, usually on port 21.',
        '',
        '    The password was not sent. Nothing was changed on production.',
        '    More: sealup.dev/e/tls-refused',
      ].join('\n'),
    );
    expect(server.commands()).toEqual(['AUTH TLS']);
  });
});

describe('pull over ftps:// (spec #41 story 14)', () => {
  it('copies the server files here over TLS, with no plain-FTP warning', async () => {
    const server = await ftpsServer();
    server.seedFile('/www/uploads/a.jpg', new Uint8Array([1, 2, 3]), { mtime: 1_700_000_000 });
    const config = ftpsConfig(selfSigned.sha256).replace(
      'targets:',
      'pull:\n  uploads: public_html/uploads\ntargets:',
    );
    const project = createProject(config, { 'public_html/index.html': 'x' });
    const run = await runMain(['pull', 'production', '--no-color'], {
      cwd: project.root,
      tty: true,
      connect: dialing(server),
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(screenOf(run.stderr)).toContain(
      '  host key    certificate CN=sealup test FTP server  pinned\n',
    );
    expect(run.stderr).not.toContain('Plain FTP');
    expect([...readFileSync(join(project.root, 'public_html', 'uploads/a.jpg'))]).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('keyscan on ftps:// (spec #41 decision 12)', () => {
  const enter = '\r';
  /** The real certificate scan, pointed at the test server. */
  const scanAt =
    (server: FtpServer): ScanCertificate =>
    (url, options) =>
      scanCertificate({ ...url, host: server.host, port: server.port }, options);
  const block = (state: string) => [
    versionLine('keyscan', 'production'),
    '  production  ftps://deploy@ftp.example.com:21/www',
    `  host key    certificate CN=sealup test FTP server  ${state}`,
    `              SHA-256 ${selfSigned.sha256}`,
    '',
    '    subject  CN=sealup test FTP server',
    '    issuer   CN=sealup test FTP server',
    '    valid    2026-10-09 to 2126-09-15',
    `    SHA-256  ${selfSigned.sha256}`,
    '',
  ];

  it('without a terminal: shows the certificate, says why the check fails, gives the line to paste', async () => {
    const server = await ftpsServer();
    const { root, config } = createProject(ftpsConfig(), { 'public_html/index.html': 'x' });
    const before = readFileSync(config, 'utf8');
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      scanCertificate: scanAt(server),
    });
    expect(run.stderr).toBe(
      [
        ...block('not pinned'),
        '  It is signed by no known authority (self-signed), or it is out of date.',
        '  Nothing was saved: sealup pins a certificate only after a yes on a terminal.',
        "  Compare the SHA-256 with your host's, then paste this line into",
        '  sealup.yml yourself (or run sealup keyscan on a terminal):',
        '',
        `  tlsFingerprint: ${selfSigned.sha256}`,
        '',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(sentUser(server)).toBe(false);
  });

  it('on a terminal: pins it on a yes, and a deploy then passes', async () => {
    const server = await ftpsServer();
    const { root, config } = createProject(ftpsConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['keyscan', 'production', '--no-color'], {
      cwd: root,
      tty: true,
      keys: ['y', enter],
      scanCertificate: scanAt(server),
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(screenOf(run.stderr)).toContain(
      [
        '  Pin it in sealup.yml as tlsFingerprint? [y/N] y',
        '',
        '  ✓ Pinned. sealup.yml now holds this certificate (tlsFingerprint, line 5).',
      ].join('\n'),
    );
    expect(readFileSync(config, 'utf8')).toBe(
      ftpsConfig(selfSigned.sha256).replace(
        `    password: ${ref('SEALUP_CANARY_PASSWORD')}\n    tlsFingerprint: ${selfSigned.sha256}\n`,
        `    tlsFingerprint: ${selfSigned.sha256}\n    password: ${ref('SEALUP_CANARY_PASSWORD')}\n`,
      ),
    );
    const deployed = await runMain(['deploy', 'production'], {
      cwd: root,
      connect: dialing(server),
    });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
  });

  it('says the pin is already there, exit 0', async () => {
    const server = await ftpsServer();
    const { root } = createProject(ftpsConfig(selfSigned.sha256), {
      'public_html/index.html': 'x',
    });
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      scanCertificate: scanAt(server),
    });
    expect(run.stderr).toBe(
      [
        ...block('pinned'),
        '  ✓ Already pinned: sealup.yml holds this certificate (tlsFingerprint, line 6).',
        '',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(0);
  });

  it('without a terminal: another pinned certificate is exit 4, the file unchanged, in --json too', async () => {
    const server = await ftpsServer();
    const { root, config } = createProject(ftpsConfig(trusted.sha256), {
      'public_html/index.html': 'x',
    });
    const before = readFileSync(config, 'utf8');
    const run = await runMain(['keyscan', 'production', '--json'], {
      cwd: root,
      scanCertificate: scanAt(server),
    });
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain(
      [
        "  ✗ The server's TLS certificate changed. sealup.yml was not changed.",
        '    sealup.yml (line 6) pins one certificate; ftp.example.com showed another:',
        `      expected  SHA-256 ${trusted.sha256}`,
        `      received  SHA-256 ${selfSigned.sha256}`,
      ].join('\n'),
    );
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(JSON.parse(run.stdout)).toMatchObject({
      command: 'keyscan',
      status: 'failed',
      exitCode: 4,
      hostKey: null,
      certificate: { sha256: selfSigned.sha256, check: 'untrusted', state: 'changed' },
      error: { code: 'certificate-refused' },
    });
  });

  it('gives the certificate in --json, hostKey null', async () => {
    const server = await ftpsServer();
    const { root } = createProject(ftpsConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['keyscan', 'production', '--json'], {
      cwd: root,
      scanCertificate: scanAt(server),
    });
    expect(JSON.parse(run.stdout)).toEqual({
      format: 1,
      version: '0.0.0-source',
      command: 'keyscan',
      target: 'production',
      server: 'ftps://deploy@ftp.example.com:21/www',
      status: 'ok',
      exitCode: 0,
      hostKey: null,
      certificate: {
        subject: selfSigned.subject,
        issuer: selfSigned.issuer,
        validFrom: '2026-10-09T06:29:23.000Z',
        validTo: '2126-09-15T06:29:23.000Z',
        sha256: selfSigned.sha256,
        check: 'untrusted',
        state: 'not-saved',
      },
    });
  });

  it('stops with exit 4 on a server that refuses AUTH TLS', async () => {
    const server = await ftpsServer(false);
    const { root } = createProject(ftpsConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      scanCertificate: scanAt(server),
    });
    expect(run.exitCode).toBe(4);
    expect(run.stderr).toContain('sealup.dev/e/tls-refused');
  });
});

// Spec #41 decision 20: each reconnect is a whole new connect, so the pin is checked again.
describe('a reconnect over ftps://', () => {
  const tenPages = (): Record<string, string> =>
    Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`public_html/p${i}.html`, `${i}`]));

  it('checks the pinned certificate again before it logs in, then sends the rest', async () => {
    const server = await ftpsServer();
    const project = createProject(`parallel: 1\n${ftpsConfig(selfSigned.sha256)}`, tenPages());
    // The connect's probe and the lock's note are STORs too: the drop comes a few uploads in.
    server.faults.failWrite(6, 'connection-lost');
    const run = await runMain(['deploy'], { cwd: project.root, connect: dialing(server) });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain('Reconnected. Resuming:');
    const commands = server.commands();
    expect(commands.filter((command) => command === 'AUTH TLS')).toHaveLength(2);
    expect(commands.indexOf('AUTH TLS', commands.indexOf('AUTH TLS') + 1)).toBeLessThan(
      commands.findLastIndex((command) => command.startsWith('USER')),
    );
  });

  it('stops at once with exit 4 when the reconnect lands on another certificate', async () => {
    const server = await ftpsServer();
    const other = await createFtpServer({
      password: canaries.SEALUP_CANARY_PASSWORD,
      tls: { key: testServerKey, cert: trusted.pem },
    });
    servers.push(other);
    const project = createProject(`parallel: 1\n${ftpsConfig(selfSigned.sha256)}`, tenPages());
    server.faults.failWrite(6, 'connection-lost');
    let connects = 0;
    const run = await runMain(['deploy'], {
      cwd: project.root,
      connect: (target, options) => dialing(connects++ === 0 ? server : other)(target, options),
    });
    expect(run.exitCode).toBe(4);
    expect(connects).toBe(2);
    expect(run.stderr).toContain('sealup.dev/e/certificate-refused');
    expect(sentUser(other)).toBe(false);
    // The same command again would stop the same way: the words give the step before it.
    expect(run.stderr).toContain(
      'Upload stopped: ftp.example.com showed another certificate on reconnect.',
    );
    expect(run.stderr).toContain(
      [
        "    Ask your host for the certificate's SHA-256. If it changed, pin the new one:",
        '      sealup keyscan production   then commit sealup.yml.',
      ].join('\n'),
    );
    expect(run.stderr).toContain(
      '    Once the new certificate is pinned, run the same command again to finish.',
    );
    expect(run.stderr).not.toContain('Run the same command again');
  });
});

describe('init with an ftps:// server', () => {
  it('writes sealup.yml with no host key placeholder and names no keyscan', async () => {
    const root = newProject({ 'dist/index.html': 'x' });
    const run = await runMain(['init', '--server', 'ftps://deploy@ftp.example.com/www'], {
      cwd: root,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(readFileSync(join(root, 'sealup.yml'), 'utf8')).toBe(
      [
        'server: ftps://deploy@ftp.example.com/www',
        `password: ${ref('SEALUP_PASSWORD')}`,
        'upload: dist',
        '',
      ].join('\n'),
    );
    expect(run.stderr).not.toContain('hostKey');
  });
});

describe('check on ftps:// (spec #41 decision 10)', () => {
  it('needs no host key: the target is ready', async () => {
    const project = createProject(ftpsConfig(), { 'public_html/index.html': 'x' });
    const run = await runMain(['check', 'production'], { cwd: project.root });
    expect(run.stderr).not.toContain('host key');
    expect(run.stderr).toContain('✓ Ready to deploy to production.');
    expect(run.exitCode).toBe(0);
  });
});
