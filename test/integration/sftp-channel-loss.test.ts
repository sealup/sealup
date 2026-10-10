// The SFTP transport when a channel is lost once open (spec sealup/sealup#15 decision 1): closed by
// the server while the others open, closed under load, or a request on it never answered. Driven
// through transport's connect, against the in-process server.

import { describe, expect, it } from 'vitest';
import { atLogin, kib, sftpTarget, testServer, testSession } from '../sftp-kit.ts';

describe('SFTP channels lost once open (spec #15, decision 1)', () => {
  it('never picks a channel the server closed while the others were still opening', async () => {
    const sftp = await testServer();
    // Channel 2 is closed once open; channel 4 never answers, so the connect waits after it.
    sftp.faults.closeChannelOnOpen(2);
    sftp.faults.stallChannelsBeyond(3);
    // A request on the lost channel would hang until `timeout`: kept short, so a slip fails fast.
    const session = await testSession(
      sftpTarget(sftp, { parallel: 8, timeoutMs: 2_000 }),
      4,
      2_000,
    );
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((name) => session.put({ bytes: kib(1) }, atLogin(session, name))));
    for (const name of names) expect(sftp.files().get(atLogin(session, name))?.size).toBe(1024);
  });

  it('hands a closed channel its share of `parallel` to the channels left', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 8 }), 4);
    sftp.faults.closeChannelOnWrite(1);
    await expect(
      session.put({ bytes: kib(1) }, atLogin(session, 'lost.txt')),
    ).rejects.toMatchObject({
      code: 'connection-lost',
    });
    sftp.faults.slow(50);
    const names = Array.from({ length: 30 }, (_, i) => `f${i}.bin`);
    await Promise.all(
      names.map((name) => session.put({ bytes: kib(100) }, atLogin(session, name))),
    );
    // 8 over the 3 channels left (3, 3 and 2), not the 6 they had (2 each).
    expect(sftp.mostInFlight()).toBe(8);
  });

  it('a channel the server closes fails only its own operations, with connection-lost', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 8 }), 4);
    sftp.faults.slow(100);
    sftp.faults.closeChannelOnWrite(1);
    const names = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
    const results = await Promise.allSettled(
      names.map((name) => session.put({ bytes: kib(1) }, atLogin(session, name))),
    );
    const failed = results.filter((result) => result.status === 'rejected');
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'connection-lost' } });
    for (const result of failed) expect(result.reason).toMatchObject({ code: 'connection-lost' });
    expect(failed.length).toBeLessThan(names.length);
    // The session goes on over the channels it still has.
    sftp.faults.slow(0);
    await Promise.all(names.map((name) => session.put({ bytes: kib(2) }, atLogin(session, name))));
    for (const name of names) expect(sftp.files().get(atLogin(session, name))?.size).toBe(2048);
  });

  it('a request with no answer fails with timeout; the other operations keep working', async () => {
    const sftp = await testServer();
    const session = await testSession(sftpTarget(sftp, { parallel: 8, timeoutMs: 300 }), 4);
    sftp.faults.failWrite(1, 'timeout');
    const names = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
    const results = await Promise.allSettled(
      names.map((name) => session.put({ bytes: kib(1) }, atLogin(session, name))),
    );
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      ...names.slice(1).map(() => 'fulfilled'),
    ]);
    expect(results[0]).toMatchObject({ reason: { code: 'timeout' } });
    await Promise.all(names.map((name) => session.put({ bytes: kib(2) }, atLogin(session, name))));
    for (const name of names) expect(sftp.files().get(atLogin(session, name))?.size).toBe(2048);
  });
});
