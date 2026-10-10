// The shared values in contracts, checked against the decisions they come from.

import { describe, expect, it } from 'vitest';
import { ExitCode, type ServerPath, TransportError } from '../../src/contracts/index.ts';

describe('ExitCode (decision 0023, item 8)', () => {
  it('has one code per outcome, each telling whether the server changed', () => {
    expect(ExitCode).toEqual({
      ok: 0,
      partial: 1,
      usage: 2,
      auth: 3,
      hostKey: 4,
      unreachable: 5,
      safetyNet: 6,
      interrupted: 130,
    });
  });
});

describe('TransportError', () => {
  it('carries a code, a reason, facts and its cause; its message is a technical line', () => {
    const cause = new Error('SFTP status 4');
    const path = '/home/site/a.html' as ServerPath;
    const error = new TransportError('quota', 'answer', {
      operation: 'upload',
      path,
      serverSaid: 'Disk quota exceeded',
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'TransportError',
      code: 'quota',
      reason: 'answer',
      operation: 'upload',
      path,
      serverSaid: 'Disk quota exceeded',
    });
    expect(error.message).toBe('quota (answer): upload /home/site/a.html');
    expect(error.cause).toBe(cause);
  });
});
