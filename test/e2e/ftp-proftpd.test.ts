// ProFTPD in a container (spec #41 decisions 6, 8 and 17; seams 2 and 3): the Session contract
// suite over FTPS (TLSRequired), pinned to the test certificate, with one limit written down: its
// MLSD leaves out a link whose target is missing. R8: a certificate no CA vouches for stops the
// run before the user name is sent (the server's command log shows none). R9: with EPSV refused
// and a PASV reply naming 192.0.2.10, every connection still goes to the server's own address.
//
// Runs where Docker runs Linux containers: always on Linux (a missing Docker fails the run), on
// other systems only when Docker answers with Linux (so Windows CI skips it).

import { describe, expect, it } from 'vitest';
import { connect } from '../../src/transport/index.ts';
import { createProject, ref, runMain } from '../deploy-kit.ts';
import {
  dialedHosts,
  ftpsContractOn,
  ftpsDeployConfig,
  otherAddress,
  useFtpContainer,
} from '../ftp-servers-kit.ts';
import { dockerRunsLinux } from '../openssh-kit.ts';

const enabled = process.platform === 'linux' || dockerRunsLinux();

describe.runIf(enabled)('ProFTPD in a container, over FTPS', () => {
  const server = useFtpContainer('proftpd', { tls: true });

  ftpsContractOn(server, { danglingLinksUnlisted: true });

  it('R8: a certificate no CA vouches for, not pinned, stops the run before USER, exit 4', async () => {
    await server().clear();
    const project = createProject(
      [
        `server: ftps://deploy@${server().host}:${server().port}/~/site`,
        `password: ${ref('SEALUP_CANARY_PASSWORD')}`,
        'upload: public_html',
        '',
      ].join('\n'),
      { 'public_html/index.html': '<h1>home</h1>\n' },
    );
    const logged = (await server().log()).length;
    const tlsLogged = (await server().log('tls')).length;

    const run = await runMain(['deploy'], { cwd: project.root, connect });

    expect(run.exitCode, run.stderr).toBe(4);
    expect(run.stderr).toContain(
      "The server's TLS certificate is not trusted. sealup stopped before logging in.",
    );
    // Once the session is over, its logs are whole. The TLS log notes AUTH TLS as it starts; the
    // command log has a line only for a command that ended, which an AUTH TLS whose handshake the
    // client left unfinished never does (seen with Node 26), so it can be empty: it holds no USER.
    await server().idle();
    expect((await server().log('tls')).slice(tlsLogged)).toContain(
      'TLS/TLS-C requested, starting TLS handshake',
    );
    expect((await server().log()).slice(logged)).not.toMatch(/^(USER|PASS)\b/m);
  });
});

describe.runIf(enabled)('ProFTPD naming another address in its PASV reply (R9)', () => {
  const server = useFtpContainer('proftpd', {
    tls: true,
    noEpsv: true,
    pasvAddress: otherAddress,
  });

  it('deploys over FTPS, every connection to the server it named, none to the other address', async () => {
    const project = createProject(ftpsDeployConfig(server()), {
      'public_html/index.html': '<h1>home</h1>\n',
      'public_html/assets/app.js': 'console.log(1);\n',
    });

    const { run, hosts } = await dialedHosts(() =>
      runMain(['deploy'], { cwd: project.root, connect }),
    );

    expect(run.exitCode, run.stderr).toBe(0);
    expect([...(await server().tree('site')).keys()]).toEqual(['assets/app.js', 'index.html']);
    expect(new Set(hosts)).toEqual(new Set([server().host]));
    const log = await server().log();
    expect(log).toMatch(/^EPSV .*=> 5\d\d /m);
    expect(log).toContain('Entering Passive Mode (192,0,2,10,');
  });
});
