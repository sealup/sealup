// The FTP transport beyond the shared contract (spec #41 decisions 3–7, 31): what it probes at
// connect, the commands an R17 put sends, R9's passive address, R4's line breaks, R21's reply
// limit, and its pool of connections. Through connectFtp and the Session, against the in-process
// FTP server.

import { describe, expect, it, vi } from 'vitest';
import type { ServerPath, Session } from '../../src/contracts/index.ts';
import { connectFtp } from '../../src/transport/index.ts';
import { ftpTarget, testFtpServer, testFtpSession } from '../ftp-kit.ts';
import { closedPort, silentServer } from '../sftp-kit.ts';

const text = (value: string): { bytes: Uint8Array } => ({
  bytes: new TextEncoder().encode(value),
});

const at = (session: Session, name: string): ServerPath =>
  `${session.loginFolder}/${name}` as ServerPath;

async function readText(session: Session, path: ServerPath): Promise<string> {
  const read = await session.read(path, 1_000);
  return read.kind === 'found' ? new TextDecoder().decode(read.bytes) : read.kind;
}

describe('the probe at connect', () => {
  it('reports posix-rename when RNTO replaces a file, and leaves no temp file', async () => {
    const server = await testFtpServer();
    const session = await testFtpSession(ftpTarget(server));
    expect(session.caps).toEqual({ replace: 'posix-rename', setMode: true, connections: 4 });
    expect([...server.files().keys()]).toEqual([]);
  });

  it('reports unlink-then-rename when RNTO refuses to replace, and rename still replaces', async () => {
    const server = await testFtpServer({ renameReplaces: false });
    const session = await testFtpSession(ftpTarget(server));
    expect(session.caps.replace).toBe('unlink-then-rename');
    await session.put(text('old'), at(session, 'a.txt'));
    await session.put(text('new'), at(session, '.a.txt.tmp'));
    await session.rename(at(session, '.a.txt.tmp'), at(session, 'a.txt'));
    expect(await readText(session, at(session, 'a.txt'))).toBe('new');
    expect([...server.files().keys()]).toEqual([at(session, 'a.txt')]);
  });

  it('reports setMode false when SITE CHMOD is refused', async () => {
    const server = await testFtpServer({ siteChmod: false });
    const session = await testFtpSession(ftpTarget(server));
    expect(session.caps.setMode).toBe(false);
  });

  it('reports setMode false when APPE restores other-read after a successful CHMOD', async () => {
    const server = await testFtpServer({ appendKeepsMode: false });
    const session = await testFtpSession(ftpTarget(server));
    expect(session.caps.setMode).toBe(false);
    expect([...server.files().keys()]).toEqual([]);
  });
});

// R16 on ProFTPD: its MLST describes what a link points to, so a link to a folder looked like a
// folder, and a write could go through it.
describe('stat on a server whose MLST follows links', () => {
  it('says link for a link to a folder, to a file, and a dangling one', async () => {
    const server = await testFtpServer({ mlstFollowsLinks: true });
    const session = await testFtpSession(ftpTarget(server));
    await session.mkdir(at(session, 'real'));
    await session.put(text('x'), at(session, 'a.txt'));
    server.seedLink(at(session, 'to-folder'), at(session, 'real'));
    server.seedLink(at(session, 'to-file'), 'a.txt');
    server.seedLink(at(session, 'dangling'), at(session, 'missing'));
    const kinds = await Promise.all(
      ['real', 'a.txt', 'to-folder', 'to-file', 'dangling', 'missing'].map(
        async (name) => (await session.stat(at(session, name))).kind,
      ),
    );
    expect(kinds).toEqual(['folder', 'file', 'link', 'link', 'link', 'not-found']);
  });
});

describe('a put with a mode (R17)', () => {
  it('refuses a folder that resets modes only for nonempty appends, before sending secret bytes', async () => {
    const server = await testFtpServer({
      appendContentKeepsMode: (path) => !path.includes('/api/'),
    });
    const session = await testFtpSession(ftpTarget(server, { parallel: 1 }));
    expect(session.caps.setMode).toBe(true);
    await session.mkdir(at(session, 'api'));
    const path = at(session, 'api/.env');
    await expect(session.put(text('APP_KEY=fake'), path, { mode: 0o600 })).rejects.toMatchObject({
      reason: 'mode-refused',
      path,
    });
    expect(await readText(session, path)).not.toContain('APP_KEY=fake');
  });
  it('sends no content when APPE resets the requested mode on this path', async () => {
    const server = await testFtpServer({ appendKeepsMode: (path) => !path.endsWith('/.env') });
    const session = await testFtpSession(ftpTarget(server, { parallel: 1 }));
    expect(session.caps.setMode).toBe(true);
    const path = at(session, '.env');
    await expect(session.put(text('APP_KEY=fake'), path, { mode: 0o600 })).rejects.toMatchObject({
      code: 'protocol',
      reason: 'mode-refused',
      path,
    });
    expect(server.files().get(path)?.size ?? 0).toBe(0);
    expect(server.files().get(path)?.firstByteMode).toBeUndefined();
  });
  it('sends STOR of an empty file, SITE CHMOD, then APPE with the content', async () => {
    const server = await testFtpServer();
    const session = await testFtpSession(ftpTarget(server, { parallel: 1 }));
    const before = server.commands().length;
    await session.put(text('APP_KEY=fake'), at(session, '.env'), { mode: 0o600 });
    const sent = server
      .commands()
      .slice(before)
      .filter((command) => /^(STOR|APPE|SITE)/.test(command));
    const path = at(session, '.env');
    expect(sent).toEqual([
      `STOR ${path}`,
      `SITE CHMOD 600 ${path}`,
      `APPE ${path}`,
      `APPE ${path}`,
      `STOR ${path}`,
      `SITE CHMOD 600 ${path}`,
      `APPE ${path}`,
      `APPE ${path}`,
    ]);
    expect(server.files().get(path)).toMatchObject({ mode: 0o600, firstByteMode: 0o600 });
  });

  it('fails with mode-refused when SITE CHMOD is refused, before any content is sent', async () => {
    const server = await testFtpServer({ siteChmod: false });
    const session = await testFtpSession(ftpTarget(server));
    await expect(
      session.put(text('APP_KEY=fake'), at(session, '.env'), { mode: 0o600 }),
    ).rejects.toMatchObject({
      name: 'TransportError',
      code: 'protocol',
      reason: 'mode-refused',
      path: at(session, '.env'),
    });
    expect(server.commands().some((command) => command.startsWith('APPE'))).toBe(false);
    expect(server.files().get(at(session, '.env'))?.size ?? 0).toBe(0);
    // The session goes on.
    await session.put(text('x'), at(session, 'a.txt'));
  });

  // ProFTPD refuses APPE unless AllowStoreRestart is on, and Debian's own config leaves it off.
  it('where APPE is refused, sends the content by STOR over the empty file once its mode held', async () => {
    const server = await testFtpServer({ append: false });
    const session = await testFtpSession(ftpTarget(server, { parallel: 1 }));
    const path = at(session, '.env');
    await session.put(text('APP_KEY=fake'), path, { mode: 0o600 });
    expect(await readText(session, path)).toBe('APP_KEY=fake');
    expect(server.files().get(path)).toMatchObject({ mode: 0o600, firstByteMode: 0o600 });
  });

  it('where APPE is refused and STOR makes a new file, fails with mode-refused, no byte sent', async () => {
    const server = await testFtpServer({ append: false, storeKeepsMode: false });
    const session = await testFtpSession(ftpTarget(server, { parallel: 1 }));
    const path = at(session, '.env');
    await expect(session.put(text('APP_KEY=fake'), path, { mode: 0o600 })).rejects.toMatchObject({
      name: 'TransportError',
      code: 'protocol',
      reason: 'mode-refused',
      path,
    });
    expect(server.files().get(path)?.size ?? 0).toBe(0);
    await session.put(text('x'), at(session, 'a.txt'));
  });
});

describe('listing (decision 6)', () => {
  it.each([
    ['MLSD when FEAT offers MLST', true, 'MLSD', 'LIST'],
    ['LIST when it does not', false, 'LIST', 'MLSD'],
  ])('uses %s, with the special mode bits', async (_, mlsd, used, unused) => {
    const server = await testFtpServer({ mlsd });
    server.seedFile(`${server.loginFolder}/run.sh`, '#!/bin/sh', { mode: 0o4755 });
    server.seedFile(`${server.loginFolder}/shared/a.txt`, 'x');
    const session = await testFtpSession(ftpTarget(server));
    const before = server.commands().length;
    const listed = await session.list(session.loginFolder, 10);
    const entries = listed.kind === 'found' ? listed.entries : [];
    expect(entries.find((entry) => entry.name === 'run.sh')).toMatchObject({
      kind: 'file',
      size: 9,
      mode: 0o4755,
    });
    expect(entries.find((entry) => entry.name === 'shared')?.kind).toBe('folder');
    const commands = server.commands().slice(before);
    expect(commands.some((command) => command.startsWith(used))).toBe(true);
    expect(commands.some((command) => command.startsWith(unused))).toBe(false);
  });
});

describe('R9: passive mode', () => {
  it('ignores the address a PASV reply names and uses the control host', async () => {
    const server = await testFtpServer({ epsv: false, pasvHost: '192.0.2.10' });
    const session = await testFtpSession(ftpTarget(server, { timeoutMs: 5_000 }));
    await session.put(text('hello'), at(session, 'a.txt'));
    expect(await readText(session, at(session, 'a.txt'))).toBe('hello');
    expect(server.commands()).toContain('PASV');
    expect(server.dataAddresses().length).toBeGreaterThan(0);
    expect(new Set(server.dataAddresses())).toEqual(new Set([server.host]));
  });
});

describe('R4: line breaks', () => {
  it('never sends a path with CR, LF or NUL, and the session goes on', async () => {
    const server = await testFtpServer();
    const session = await testFtpSession(ftpTarget(server));
    for (const bad of ['a\r\nDELE x', 'b\nc', 'd\0e']) {
      await expect(session.put(text('x'), at(session, bad))).rejects.toThrow(RangeError);
      await expect(session.remove(at(session, bad))).rejects.toThrow(RangeError);
    }
    const injected = (command: string): boolean =>
      command === 'DELE x' || /[\n\0]|\/a$/.test(command);
    expect(server.commands().filter(injected)).toEqual([]);
    await session.put(text('x'), at(session, 'ok.txt'));
    expect(await readText(session, at(session, 'ok.txt'))).toBe('x');
  });
});

describe('R21: control replies', () => {
  it('takes a long reply under 64 kB', async () => {
    const server = await testFtpServer();
    const session = await testFtpSession(ftpTarget(server, { parallel: 1 }));
    server.faults.longReply(60_000);
    await session.put(text('x'), at(session, 'a.txt'));
    expect(await readText(session, at(session, 'a.txt'))).toBe('x');
  });

  it('fails an operation whose reply passes 64 kB, and the session with it', async () => {
    const server = await testFtpServer();
    const session = await testFtpSession(ftpTarget(server, { parallel: 1 }));
    server.faults.longReply(70_000);
    await expect(session.mkdir(at(session, 'a'))).rejects.toMatchObject({
      name: 'TransportError',
      code: 'protocol',
    });
    await expect(session.mkdir(at(session, 'b'))).rejects.toMatchObject({
      code: 'connection-lost',
    });
  });
});

describe('the pool (decision 4)', () => {
  it.each([
    [4, 4],
    [1, 1],
    [64, 16],
  ])('opens parallel %i as %i connections', async (parallel, logins) => {
    const server = await testFtpServer();
    await testFtpSession(ftpTarget(server, { parallel }));
    expect(server.logins()).toBe(logins);
  });

  it('goes on with the connections the server allows, without an error', async () => {
    const server = await testFtpServer({ maxConnections: 2 });
    const session = await testFtpSession(ftpTarget(server, { parallel: 4 }));
    expect(server.logins()).toBe(2);
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((name) => session.put(text(name), at(session, name))));
    expect(await readText(session, at(session, 'f9.txt'))).toBe('f9.txt');
  });

  it('leaves out connections the server closed while idle, and goes on with the others', async () => {
    const server = await testFtpServer();
    const session = await testFtpSession(ftpTarget(server, { parallel: 4 }));
    server.faults.closeConnections(3);
    await vi.waitFor(() => expect(server.openConnections()).toBe(1));
    const names = Array.from({ length: 6 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((name) => session.put(text(name), at(session, name))));
    expect(await readText(session, at(session, 'f5.txt'))).toBe('f5.txt');
  });

  it('is lost once the server has closed every connection', async () => {
    const server = await testFtpServer();
    const session = await testFtpSession(ftpTarget(server, { parallel: 2 }));
    server.faults.closeConnections(2);
    await server.closed();
    await expect(session.mkdir(at(session, 'a'))).rejects.toMatchObject({
      code: 'connection-lost',
    });
  });

  it('sends a refused password once, whatever parallel says (I-072)', async () => {
    const server = await testFtpServer();
    server.faults.refuseLogin();
    await expect(
      connectFtp(ftpTarget(server, { parallel: 4 }), { signal: undefined }),
    ).rejects.toMatchObject({ code: 'auth', reason: 'login-refused' });
    expect(server.commands().filter((command) => command.startsWith('PASS'))).toHaveLength(1);
  });
});

// `timeout` bounds each command once the session is open, not the connect: over a slow link (or
// on a loaded machine) the login, the login folder and the probe take longer than a short one,
// as on SFTP. The connect has its own bound (`timeout`, never under 10 s).
describe('timeout and the connect', () => {
  it('logs in and probes over a link slower than a short `timeout`, then times out a slow command', async () => {
    const server = await testFtpServer();
    server.faults.slow(100);
    const session = await testFtpSession(ftpTarget(server, { timeoutMs: 50 }));
    expect(session.caps).toMatchObject({ replace: 'posix-rename', setMode: true });
    server.faults.slow(5_000);
    await expect(session.put(text('x'), at(session, 'a.txt'))).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('connect failures', () => {
  it('says the port does not speak FTP when an SSH server answers', async () => {
    const ssh = await silentServer('SSH-2.0-OpenSSH_9.6\r\n');
    try {
      const target = ftpTarget(await testFtpServer());
      await expect(
        connectFtp(
          { ...target, server: { ...target.server, host: ssh.host, port: ssh.port } },
          { signal: undefined },
        ),
      ).rejects.toMatchObject({ code: 'protocol', reason: 'not-ftp' });
    } finally {
      await ssh.stop();
    }
  });

  it('says the connection was refused on a closed port', async () => {
    const target = ftpTarget(await testFtpServer());
    const port = await closedPort();
    await expect(
      connectFtp({ ...target, server: { ...target.server, port } }, { signal: undefined }),
    ).rejects.toMatchObject({ code: 'unreachable', reason: 'refused' });
  });

  it('stops at once on Ctrl-C before login', async () => {
    const target = ftpTarget(await testFtpServer());
    await expect(connectFtp(target, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'unreachable',
      reason: 'interrupted',
    });
  });
});
