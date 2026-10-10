// `server: protocol://user@host[:port]/folder` (decision 0022 §4), parsed by hand: WHATWG URL
// percent-encodes folders and drops the default port, and a user's folder must round-trip as
// written. The folder is absolute, or relative to the login folder when it starts with `/~/`.
// `ssh://` is SFTP plus a shell, for the archive (0034): its folder goes in the archive's one
// command, so it must also fit R15's strict character set. `ftp://` is plain FTP and `ftps://`
// FTP with explicit TLS, both on port 21 unless the URL names one (spec #41 decisions 8, 10).
// Every protocol of decision 0022 is in this version: any other scheme is not a server URL.

import type { ServerUrl } from '../contracts/index.ts';
import { inCommandSet, parseRemotePath, parseServerPath } from '../paths/index.ts';

type ServerUrlResult =
  | { readonly ok: true; readonly url: ServerUrl }
  | { readonly ok: false; readonly problem: 'server-url' };

const shape =
  /^(?<scheme>[a-z][a-z0-9+.-]*):\/\/(?<user>[^/@]+)@(?<host>\[[0-9A-Fa-f:.]+\]|[^/:@[\]]+)(?::(?<port>\d{1,5}))?(?<folder>\/.*)$/;
/** The port of each protocol when the URL names none. */
const defaultPorts = { sftp: 22, ssh: 22, ftp: 21, ftps: 21 } as const;
const isProtocol = (scheme: string): scheme is ServerUrl['protocol'] =>
  Object.hasOwn(defaultPorts, scheme);

export function parseServerUrl(text: string): ServerUrlResult {
  // R4: no control character reaches a library; this also rules out CR/LF in user or host.
  if (/\p{Cc}/u.test(text)) return refuse();
  const groups = shape.exec(text)?.groups;
  if (groups === undefined) return refuse();
  const { scheme, user, host, port, folder } = groups;
  if (scheme === undefined || user === undefined || host === undefined || folder === undefined) {
    return refuse();
  }
  if (!isProtocol(scheme)) return refuse();
  // `user:password@` is refused: a password lives in a variable, never in the URL (R3).
  if (user.includes(':')) return refuse();
  const portNumber = port === undefined ? defaultPorts[scheme] : Number(port);
  if (portNumber < 1 || portNumber > 65_535) return refuse();
  if (!validFolder(folder)) return refuse();
  if (scheme === 'ssh' && !inCommandSet(folder)) return refuse();
  return { ok: true, url: { protocol: scheme, user, host, port: portNumber, folder } };
}

function validFolder(folder: string): boolean {
  if (folder === '/~' || folder === '/~/') return true;
  if (folder.startsWith('/~/')) return parseRemotePath(folder.slice('/~/'.length)).ok;
  return parseServerPath(folder).ok;
}

function refuse(): ServerUrlResult {
  return { ok: false, problem: 'server-url' };
}
