// Golden S19, "Server unreachable: wrong port" (CLI page, docs/exploration/assets/06/
// scenarios-problems.js). `sealup deploy production`, exit 5: the server URL says sftp:// on
// port 21, and that port answers with an FTP greeting. Over the real transport, against a server
// that sends `220` and waits, as FTP does. Because sealup saw the FTP greeting (and only then), it
// says what is wrong and which characters to delete (spec #41 decision 9).
//
// Page form:
//   production  sftp://deploy@ssh.example.com:21/home/site
//   host key    not checked
//
//   ✗ No SFTP server at ssh.example.com:21: this port speaks FTP.
//     It answered with an FTP greeting (220), not an SSH one.
//     SFTP is usually port 22: remove :21 from server (sealup.yml line 15).
//
//     sealup did not log in. Nothing was changed on production.
//     More: sealup.dev/e/wrong-protocol
//
// The server line is line 4 of this fixture. The other forms of the same greeting are below the
// goldens: `ssh://` on port 21, and an FTP server on port 22, where no port can be removed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  inGitHub,
  markdown,
  productionConfig,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';
import { dialing, scanDialing, silentServer } from '../../sftp-kit.ts';

let ftp: Awaited<ReturnType<typeof silentServer>>;
beforeAll(async () => {
  ftp = await silentServer('220 FTP server ready.\r\n');
});
afterAll(() => ftp.stop());

const config = productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }).replace(':22/', ':21/');

const s19 = [
  '  production  sftp://deploy@ssh.example.com:21/home/site',
  '  host key    {d}not checked{/}',
  '',
  '  {rb}✗{/} {b}No SFTP server at ssh.example.com:21: this port speaks FTP.{/}',
  '    It answered with an FTP greeting (220), not an SSH one.',
  '    SFTP is usually port 22: remove :21 from server (sealup.yml line 4).',
  '',
  '    sealup did not log in. Nothing was changed on production.',
  '    {d}More: sealup.dev/e/wrong-protocol{/}',
];

describe('S19: server unreachable, wrong port', () => {
  const deploy = (tty: boolean, env = {}, yaml = config) => {
    const project = createProject(yaml, { 'public_html/index.html': '<h1>home</h1>' });
    const connect = dialing(ftp);
    return runMain(['deploy', 'production'], { cwd: project.root, tty, env, connect });
  };

  it('prints the page layout in colour on a terminal and exits 5', async () => {
    const run = await deploy(true);
    expect(run.stderr).toBe(goldenText(s19, { color: true }));
    expect(run.exitCode).toBe(5);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', async () => {
    const run = await deploy(false);
    const s19log = ['sealup 0.0.0-source · deploy production', ...s19];
    expect(run.stderr).toBe(goldenText(s19log, { color: false }));
    expect(run.exitCode).toBe(5);
  });

  it('prints the GitHub form: masks, the same words, the page annotation', async () => {
    const run = await deploy(false, inGitHub);
    const s19github = [
      ...canaryMasks,
      'sealup 0.0.0-source · deploy production',
      ...s19,
      '::error file=sealup.yml,line=4,title=Wrong port for SFTP::ssh.example.com:21 answered with an FTP greeting, not SSH. SFTP is usually port 22: remove :21 from server in sealup.yml. Nothing was changed on production.',
    ];
    expect(run.stderr).toBe(goldenText(s19github, { color: true }));
    expect(run.exitCode).toBe(5);
  });

  it('writes the page job summary: the port, the fix, the key not checked', async () => {
    const run = await deploy(false, inGitHub);
    expect(run.summary).toBe(
      markdown([
        '### ❌ No SFTP server on port 21: nothing was changed on production',
        '',
        '> [!CAUTION]',
        '> `ssh.example.com:21` answered with an FTP greeting (220), not an SSH one: this port speaks FTP.',
        '>',
        '> **Fix:** SFTP is usually port 22. Remove `:21` from `server` (sealup.yml line 4).',
        '',
        '| Target | `sftp://deploy@ssh.example.com:21/home/site` |',
        '|---|---|',
        '| Host key | not checked: the port answered with FTP |',
        '| Site | https://example.com |',
        '',
        summaryFooter('wrong-protocol'),
      ]),
    );
  });

  it('gives the slug and the words in --json', async () => {
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    const run = await runMain(['deploy', 'production', '--json'], {
      cwd: project.root,
      connect: dialing(ftp),
    });
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'failed',
      exitCode: 5,
      error: {
        code: 'wrong-protocol',
        message: 'No SFTP server at ssh.example.com:21: this port speaks FTP.',
        fix: [
          'It answered with an FTP greeting (220), not an SSH one.',
          'SFTP is usually port 22: remove :21 from server (sealup.yml line 4).',
        ].join('\n'),
      },
    });
  });

  it('says SSH for an ssh:// URL', async () => {
    const run = await deploy(false, {}, config.replace('sftp://', 'ssh://'));
    expect(run.stderr).toContain(
      [
        '  ✗ No SSH server at ssh.example.com:21: this port speaks FTP.',
        '    It answered with an FTP greeting (220), not an SSH one.',
        '    SSH is usually port 22: remove :21 from server (sealup.yml line 4).',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(5);
  });

  it('names ftp:// on port 22, where no port can be removed (story 15)', async () => {
    const run = await deploy(false, {}, config.replace(':21/', ':22/'));
    expect(run.stderr).toContain(
      [
        '  ✗ No SFTP server at ssh.example.com:22: this port speaks FTP.',
        '    It answered with an FTP greeting (220), not an SSH one.',
        '    If the host offers only FTP, write ftp:// in server (sealup.yml line 4).',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(5);
  });

  // keyscan's problems are worded without the target (it reads only the server URL): the reason
  // and S19's page, not the page's title.
  it('stops keyscan at the greeting too, with the same page', async () => {
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    const run = await runMain(['keyscan', 'production'], {
      cwd: project.root,
      scan: scanDialing(ftp),
    });
    expect(run.stderr).toContain('  ✗ It answered with an FTP greeting (220), not an SSH one.');
    expect(run.stderr).toContain('    More: sealup.dev/e/wrong-protocol');
    expect(run.exitCode).toBe(5);
  });
});
