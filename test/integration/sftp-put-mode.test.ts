// The SFTP transport's put with a mode (R17), where the wire matters beyond the Session contract
// suite: the mode is on the file before its first byte is written, for a new file and for one
// that was there, readable by all. Driven through transport's connect, against the in-process
// server, which records the mode each file had when its first byte arrived.

import { describe, expect, it } from 'vitest';
import { atLogin, kib, sftpTarget, testServer, testSession } from '../sftp-kit.ts';

describe('SFTP put with a mode', () => {
  it('creates the file with the mode before its first byte (several chunks)', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp));
    await session.put({ bytes: kib(100) }, atLogin(session, '.env'), { mode: 0o600 });
    const file = sftp.files().get(atLogin(session, '.env'));
    expect(file?.size).toBe(100 * 1024);
    expect(file?.firstByteMode).toBe(0o600);
    expect(file?.mode).toBe(0o600);
  });

  it('sets the mode on an old file readable by all before writing to it', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp));
    sftp.seedFile(atLogin(session, '.env'), 'OLD=1\n', { mode: 0o644 });
    await session.put({ bytes: kib(1) }, atLogin(session, '.env'), { mode: 0o600 });
    expect(sftp.files().get(atLogin(session, '.env'))?.firstByteMode).toBe(0o600);
  });

  it('without a mode, writes under the mode the server gives (the record bites)', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp));
    await session.put({ bytes: kib(1) }, atLogin(session, 'index.html'));
    expect(sftp.files().get(atLogin(session, 'index.html'))?.firstByteMode).toBe(0o644);
  });
});
