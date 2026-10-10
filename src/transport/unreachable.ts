// A socket error before login, as a TransportError (`unreachable`, decision 0023's exit 5): the
// same reasons for SFTP and FTP, from Node's error codes; Ctrl-C before login; the handshake's
// bound. Shared by both connects.

import { TransportError } from '../contracts/index.ts';

/** The reason for a socket's error `code` (ECONNREFUSED, ENOTFOUND, …); `cause` kept for --debug. */
export function unreachable(code: unknown, cause: unknown): TransportError {
  const options = { cause };
  switch (code) {
    case 'ECONNREFUSED':
      return new TransportError('unreachable', 'refused', options);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
      return new TransportError('unreachable', 'no-such-host', options);
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new TransportError('unreachable', 'no-route', options);
    default:
      return new TransportError('unreachable', 'broken', options);
  }
}

/** Ctrl-C before login, over SFTP or FTP. */
export function interrupted(): TransportError {
  return new TransportError('unreachable', 'interrupted');
}

/** The least a connect gets to greet and log in, whatever `timeout` says. */
const minHandshakeMs = 10_000;

/** How long a connect may take to greet and log in: the target's timeout, at least 10 s. */
export function handshakeBound(timeoutMs: number): number {
  return Math.max(timeoutMs, minHandshakeMs);
}
