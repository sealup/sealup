// The real transport logs in with a private key (decision 0033, spec #41 decisions 16 and 17),
// against the in-process SFTP server: the key is read before anything is dialled, so an
// unreadable key or a wrong passphrase never reaches the network; the key is the one method,
// tried once, and a key the server refuses is a refused login, never retried (I-072).

import { describe, expect, it } from 'vitest';
import { type Target, TransportError } from '../../src/contracts/index.ts';
import { createFileSecret, createSecret } from '../../src/secret/index.ts';
import { userKey } from '../../src/testkit/index.ts';
import { connect } from '../../src/transport/index.ts';
import { closedPort, sftpTarget, testServer, testSession } from '../sftp-kit.ts';

/** `target` logging in with `key` (and `passphrase`), no password. */
function withKey(target: Target, key: string, passphrase?: string): Target {
  const made = createFileSecret('DEPLOY_KEY', key);
  if (!made.ok) throw new Error('test key refused');
  const { password: _, ...rest } = target;
  const opened = passphrase === undefined ? undefined : createSecret('KEY_PASSPHRASE', passphrase);
  if (opened !== undefined && !opened.ok) throw new Error('test passphrase refused');
  return {
    ...rest,
    privateKey: made.secret,
    ...(opened === undefined ? {} : { passphrase: opened.secret }),
  };
}

/** The TransportError a connect rejects with. */
async function failure(target: Target): Promise<TransportError> {
  const error = await connect(target, { signal: undefined }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TransportError)) throw new Error(`expected a TransportError: ${error}`);
  return error;
}

describe('transport: login with a private key', () => {
  it('logs in with a key the server holds in authorized_keys, signed, password never tried', async () => {
    const key = userKey();
    const server = await testServer({ authorizedKeys: [key.publicLine] });
    const session = await testSession(withKey(sftpTarget(server), key.private));
    expect(session.loginFolder).toBe('/home/deploy');
    expect(server.logins().map(({ method }) => method)).not.toContain('password');
    expect(server.logins().at(-1)).toEqual({ method: 'publickey', accepted: true });
  });

  it('opens an encrypted key with its passphrase', async () => {
    const key = userKey({ passphrase: 'correct horse battery' });
    const server = await testServer({ authorizedKeys: [key.publicLine] });
    const session = await testSession(
      withKey(sftpTarget(server), key.private, 'correct horse battery'),
    );
    expect(session.loginFolder).toBe('/home/deploy');
  });

  it('reads a key with CRLF line ends, as a Windows editor saves it', async () => {
    const key = userKey();
    const server = await testServer({ authorizedKeys: [key.publicLine] });
    const crlf = key.private.replaceAll('\n', '\r\n');
    const session = await testSession(withKey(sftpTarget(server), crlf));
    expect(session.loginFolder).toBe('/home/deploy');
  });

  it('reports a key the server refuses as a refused login, after one try', async () => {
    const server = await testServer({ authorizedKeys: [userKey().publicLine] });
    const error = await failure(withKey(sftpTarget(server), userKey().private));
    expect([error.code, error.reason]).toEqual(['auth', 'login-refused']);
    await server.closed();
    expect(server.logins()).toEqual([{ method: 'publickey', accepted: false }]);
  });
});

describe('transport: a key it cannot read stops before dialling (decision 0033)', () => {
  // Nothing listens on the port: a connect that dialled would fail as unreachable instead.
  const nowhere = async (): Promise<Target> => {
    const port = await closedPort();
    const server = await testServer();
    return sftpTarget({ ...server, port });
  };

  it.each([
    ['text that is no key', 'this is not a private key at all'],
    ['a public key', userKey().publicLine],
    ['a key written on one line with \\n escapes', userKey().private.replaceAll('\n', '\\n')],
  ])('refuses %s as unreadable', async (_, text) => {
    const error = await failure(withKey(await nowhere(), text));
    expect([error.code, error.reason]).toEqual(['private-key', 'key-unreadable']);
  });

  it('asks for the passphrase of an encrypted key given none', async () => {
    const key = userKey({ passphrase: 'correct horse battery' });
    const error = await failure(withKey(await nowhere(), key.private));
    expect([error.code, error.reason]).toEqual(['private-key', 'passphrase-missing']);
  });

  it('refuses a wrong passphrase', async () => {
    const key = userKey({ passphrase: 'correct horse battery' });
    const error = await failure(withKey(await nowhere(), key.private, 'wrong horse battery'));
    expect([error.code, error.reason]).toEqual(['private-key', 'passphrase-wrong']);
  });

  it('never puts the key or the passphrase in the error', async () => {
    const key = userKey({ passphrase: 'correct horse battery' });
    const error = await failure(withKey(await nowhere(), key.private, 'wrong horse battery'));
    const told = `${error.message} ${String(error.cause ?? '')} ${JSON.stringify(error)}`;
    expect(told).not.toContain('wrong horse');
    expect(told).not.toContain(key.private.split('\n')[1] ?? '');
  });
});
