// A server problem in words (decision 0024 §5): one sentence from a TransportError's code, reason
// and facts (transport gives facts only), and the docs slug of each code. Pure (import rules,
// pure file): no node: import.

import type { TransportError, TransportOperation } from '../contracts/index.ts';
import { formatSeconds } from './format.ts';
import type { Slug } from './problems.ts';

/** What sealup was doing, as the sentences say it. */
const doing: Readonly<Record<TransportOperation, string>> = {
  upload: 'upload',
  rename: 'rename',
  delete: 'delete',
  mkdir: 'create the folder',
  rmdir: 'remove the folder',
  read: 'read',
  look: 'look at',
  list: 'list the folder',
  download: 'download',
};

/**
 * A server problem in one sentence, from its code, reason and facts (transport gives facts
 * only). `host` is the target's, when known.
 */
export function serverSentence(error: TransportError, host: string | undefined): string {
  const seconds = formatSeconds(error.timeoutMs ?? 0);
  switch (error.reason) {
    case 'no-host-key':
      return 'No host key is pinned for this target.';
    case 'other-key':
      return "The server's host key is not the pinned one.";
    case 'key-unreadable':
      return 'sealup cannot read the private key.';
    case 'passphrase-missing':
      return 'The private key needs a passphrase.';
    case 'passphrase-wrong':
      return 'The passphrase does not open the private key.';
    case 'login-refused':
      return 'The server refused the login.';
    case 'tls-refused':
      return error.serverSaid === undefined
        ? 'The server refused TLS (AUTH TLS).'
        : `The server refused TLS (AUTH TLS): ${error.serverSaid}`;
    case 'certificate-untrusted':
      return 'The TLS certificate is signed by no known authority, or is out of date.';
    case 'certificate-name':
      return `The TLS certificate names another host than ${host ?? 'the server'}.`;
    case 'certificate-other':
      return 'The TLS certificate is not the one tlsFingerprint pins.';
    case 'refused':
      return 'The connection was refused on that port.';
    case 'no-such-host':
      return host === undefined
        ? 'No host of that name was found.'
        : `No host named ${host} was found.`;
    case 'no-route':
      return 'The network gives no way to that host.';
    case 'closed':
      return 'The server closed the connection before login.';
    case 'broken':
      return 'The connection broke before login.';
    case 'handshake':
      return 'The server did not finish the handshake in time.';
    case 'speaks-ftp':
      return 'It answered with an FTP greeting (220), not an SSH one.';
    case 'interrupted':
      return 'Stopped before login: interrupted.';
    case 'no-answer':
      return `No answer from the server in ${seconds}.`;
    case 'not-ssh':
      return 'The server did not answer as an SSH server does.';
    case 'no-sftp':
      return 'The server does not offer SFTP to this user.';
    case 'not-ftp':
      return 'The server did not answer as an FTP server does.';
    case 'mode-refused':
      return `The server refused to set the permissions of ${error.path ?? 'a file'} (SITE CHMOD).`;
    case 'no-login-folder':
      return 'The server did not tell its login folder.';
    case 'lost':
      return 'The connection to the server was lost.';
    case 'in-the-way':
      return `A ${error.inTheWay ?? 'file'} is in the way: ${error.path ?? 'a path'}.`;
    case 'changed':
      return `${error.path ?? 'A file'} changed on the server while it was downloaded.`;
    case 'answer': {
      const what = `Cannot ${doing[error.operation ?? 'look']} ${error.path ?? 'a path'}`;
      const said = error.serverSaid === undefined ? '' : ` (the server said: ${error.serverSaid})`;
      if (error.code === 'not-found') return `${what}: no such file or folder.`;
      if (error.code === 'permission') return `${what}: permission denied.`;
      if (error.code === 'quota') return `${what}: the server is out of space.`;
      return `${what}: the server failed${said}.`;
    }
  }
}

/**
 * The docs slug of a server problem: its code's; S19's for a port that speaks FTP; for FTPS, TLS
 * refused or a certificate refused.
 */
export function transportSlug(error: TransportError): Slug {
  if (error.reason === 'speaks-ftp') return 'wrong-protocol';
  if (error.code === 'tls') {
    return error.reason === 'tls-refused' ? 'tls-refused' : 'certificate-refused';
  }
  return transportSlugs[error.code];
}

const transportSlugs = {
  auth: 'login-refused',
  'host-key': 'host-key-changed',
  unreachable: 'unreachable',
  'not-found': 'server-not-found',
  permission: 'permission-denied',
  quota: 'quota-full',
  'connection-lost': 'connection-lost',
  timeout: 'timeout',
  protocol: 'protocol-error',
  'private-key': 'private-key-unreadable',
} as const satisfies Record<Exclude<TransportError['code'], 'tls'>, Slug>;
