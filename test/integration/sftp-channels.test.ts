// The SFTP transport's channels: how many it opens on its one connection, and how it goes on when
// the server refuses one or never answers (spec sealup/sealup#15 decision 1); a channel lost once
// open is in sftp-channel-loss.test.ts. Driven through transport's connect, against the
// in-process server. The SFTP transport's tests are split over several files so Vitest runs them
// side by side.

import { describe, expect, it } from 'vitest';
import { defaultChannels } from '../../src/transport/index.ts';
import { atLogin, kib, sftpTarget, testServer, testSession } from '../sftp-kit.ts';

describe('SFTP channels on one connection (spec #15, decision 1)', () => {
  it('opens the default number of channels, on one connection', async () => {
    const sftp = await testServer();
    await testSession(sftpTarget(sftp, { parallel: 64 }));
    expect(defaultChannels).toBeGreaterThan(1);
    expect(sftp.channels()).toEqual([defaultChannels]);
  });

  it('opens no more channels than `parallel`; `parallel: 1` opens one', async () => {
    const two = await testServer();
    await testSession(sftpTarget(two, { parallel: 2 }), 6);
    expect(two.channels()).toEqual([2]);
    const one = await testServer();
    await testSession(sftpTarget(one, { parallel: 1 }));
    expect(one.channels()).toEqual([1]);
  });

  it('takes the channel count from connect (tests, the measurement script)', async () => {
    const sftp = await testServer();
    await testSession(sftpTarget(sftp, { parallel: 64 }), 6);
    expect(sftp.channels()).toEqual([6]);
  });

  it('goes on with the channels a server grants, when it refuses the others', async () => {
    const sftp = await testServer();
    sftp.faults.refuseChannelsBeyond(2);
    const session = await testSession(sftpTarget(sftp, { parallel: 64 }), 4);
    expect(sftp.channels()).toEqual([2]);
    const names = Array.from({ length: 40 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((name) => session.put({ bytes: kib(1) }, atLogin(session, name))));
    for (const name of names) expect(sftp.files().get(atLogin(session, name))?.size).toBe(1024);
  });

  it('works with the first channel alone when the server refuses every other', async () => {
    const sftp = await testServer();
    sftp.faults.refuseChannelsBeyond(1);
    const session = await testSession(sftpTarget(sftp, { parallel: 8 }));
    expect(sftp.channels()).toEqual([1]);
    sftp.faults.slow(50);
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((name) => session.put({ bytes: kib(1) }, atLogin(session, name))));
    // All of `parallel` goes to the channel the session has.
    expect(sftp.mostInFlight()).toBe(8);
  });

  it('drops a channel open the server never answers, and goes on with the others', async () => {
    const sftp = await testServer();
    sftp.faults.stallChannelsBeyond(2);
    // The extra channels wait no longer than the connect bound has left: the connect never fails.
    const session = await testSession(sftpTarget(sftp, { parallel: 64 }), 4, 2_000);
    expect(sftp.channels()).toEqual([2]);
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((name) => session.put({ bytes: kib(1) }, atLogin(session, name))));
    for (const name of names) expect(sftp.files().get(atLogin(session, name))?.size).toBe(1024);
  });
});
