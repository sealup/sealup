// Pure-FTPd in a container (spec #41 decisions 6, 8 and 17; seams 2 and 3): the Session contract
// suite over FTPS, TLS required on the control and data connections, pinned to the test
// certificate; and R8, a certificate no CA vouches for stops the run before the login.
//
// Runs where Docker runs Linux containers: always on Linux (a missing Docker fails the run), on
// other systems only when Docker answers with Linux (so Windows CI skips it).

import { describe, expect, it } from 'vitest';
import { connect } from '../../src/transport/index.ts';
import { createProject, ref, runMain } from '../deploy-kit.ts';
import { ftpsContractOn, useFtpContainer } from '../ftp-servers-kit.ts';
import { dockerRunsLinux } from '../openssh-kit.ts';

const enabled = process.platform === 'linux' || dockerRunsLinux();

describe.runIf(enabled)('Pure-FTPd in a container, over FTPS', () => {
  const server = useFtpContainer('pure-ftpd', { tls: true });

  ftpsContractOn(server);

  it('R8: a certificate no CA vouches for, not pinned, stops the run with exit 4', async () => {
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
    const run = await runMain(['deploy'], { cwd: project.root, connect });
    expect(run.exitCode, run.stderr).toBe(4);
    expect(run.stderr).toContain(
      "The server's TLS certificate is not trusted. sealup stopped before logging in.",
    );
    expect(await server().folders('.')).toEqual([]);
  });
});
