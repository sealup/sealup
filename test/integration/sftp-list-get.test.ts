// The SFTP transport's `list` and `get`, where the wire matters beyond the Session contract suite:
// how many READDIR requests a listing sends (R21), and the kind bits of a mode. Driven through
// transport's connect, against the in-process server.

import { describe, expect, it } from 'vitest';
import { atLogin, sftpTarget, testServer, testSession } from '../sftp-kit.ts';

describe('SFTP list', () => {
  // The in-process server sends 100 names per READDIR answer, as OpenSSH does.
  it('stops asking for names once over maxEntries: nothing more is read (R21)', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp));
    for (let i = 0; i < 250; i++) sftp.seedFile(atLogin(session, `up/f${i}.jpg`), '');
    expect(await session.list(atLogin(session, 'up'), 99)).toEqual({ kind: 'too-many' });
    expect(sftp.readdirs()).toBe(1);
    expect(await session.list(atLogin(session, 'up'), 150)).toEqual({ kind: 'too-many' });
    expect(sftp.readdirs()).toBe(3);
    const all = await session.list(atLogin(session, 'up'), 250);
    expect(all.kind === 'found' && all.entries.length).toBe(250);
  });

  it('gives a socket, a device or a pipe as other, from the kind bits of its mode', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp));
    sftp.seedOther(atLogin(session, 'php.sock'));
    sftp.seedFile(atLogin(session, 'run.sh'), '#!/bin/sh\n', { mtime: 1_700_000_000, mode: 0o750 });
    const listed = await session.list(session.loginFolder, 10);
    const entries = listed.kind === 'found' ? listed.entries : [];
    expect(entries.find((entry) => entry.name === 'php.sock')?.kind).toBe('other');
    expect(entries.find((entry) => entry.name === 'run.sh')).toEqual({
      name: 'run.sh',
      kind: 'file',
      size: 10,
      mtime: 1_700_000_000,
      mode: 0o750,
    });
  });
});
