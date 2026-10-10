// The server's identity as the target block's second line shows it (the host-key event): known
// before connecting (none for plain FTP, S23; missing for SFTP and SSH without a hostKey, S16),
// after a failed connect (S17-S19; FTPS: the certificate refused, R8), or once connected (the
// pinned host key; the FTPS certificate, verified or pinned, spec #41 decision 10). Shared by
// deploy and pull.

import type { HostKeyCheck, Session, Target, TransportError } from '../contracts/index.ts';

/**
 * The server identity's line known before connecting (the target block's second line): plain FTP
 * has none (S23); SFTP and SSH without a `hostKey` stop there (S16). Undefined when it is known
 * only once connected: a pinned host key, an FTPS certificate.
 */
export function identityBefore(target: Target): HostKeyCheck | undefined {
  const { protocol } = target.server;
  if (protocol === 'ftp') return { state: 'none' };
  if (protocol === 'ftps' || target.hostKey !== undefined) return undefined;
  return { state: 'missing' };
}

/** The server identity's line after a failed connect (S17-S19; FTPS: R8). */
export function identityAfterFailure(
  error: TransportError,
  target: Target,
): HostKeyCheck | undefined {
  const { protocol } = target.server;
  if (protocol === 'ftp') return undefined;
  if (protocol === 'ftps') {
    const { certificate } = error;
    if (certificate === undefined) return { state: 'not-checked' };
    const check = error.code === 'tls' ? 'refused' : pinnedOrVerified(target);
    return { state: 'certificate', certificate, check };
  }
  return target.hostKey === undefined ? undefined : hostKeyAfter(error, target.hostKey.fingerprint);
}

/** The server identity's line once connected: the pinned host key, or the FTPS certificate. */
export function identityAfterConnect(session: Session, target: Target): HostKeyCheck | undefined {
  const { protocol } = target.server;
  if (protocol === 'ftps' && session.certificate !== undefined) {
    return {
      state: 'certificate',
      certificate: session.certificate,
      check: pinnedOrVerified(target),
    };
  }
  if (protocol === 'ftp' || target.hostKey === undefined) return undefined;
  return { state: 'verified', fingerprint: target.hostKey.fingerprint };
}

function pinnedOrVerified(target: Target): 'pinned' | 'verified' {
  return target.tlsFingerprint === undefined ? 'verified' : 'pinned';
}

/**
 * What a failed connect tells about the host key: the server sent another one (S17), or the
 * login was refused after the key matched (S18: the key is checked before the password, R7), or
 * the connection failed before the key was seen (S19).
 */
function hostKeyAfter(error: TransportError, pinned: string): HostKeyCheck {
  if (error.code === 'auth') return { state: 'verified', fingerprint: pinned };
  if (error.code === 'host-key' && error.received !== undefined) {
    return { state: 'changed', received: error.received };
  }
  return { state: 'not-checked' };
}
