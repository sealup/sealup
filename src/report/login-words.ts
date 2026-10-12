// The words of a connect that failed before login: the host key (S17), the password (S18), the
// network. Pure (import rules, pure file): no node: import.

import type { ConfigPlace, Target, TransportError } from '../contracts/index.ts';
import { keyType, lineOf, lineWord } from './format.ts';
import type { Explained } from './problems.ts';
import { serverSentence } from './server-words.ts';
import { changedFixLines } from './variable-words.ts';

/** How a target logs in, as the words name it: its variable and its place (decision 0033). */
interface Login {
  readonly kind: 'password' | 'private-key';
  readonly variable: string;
  /** `targets.production.password`, or the target's privateKey key path. */
  readonly keyPath: string;
}

/** The password or the private key a target logs in with. */
export function loginOf(target: Target): Login {
  const { privateKey, password, places } = target;
  const secret = privateKey ?? password;
  const place: ConfigPlace | undefined =
    privateKey === undefined ? places.password : places.privateKey;
  return {
    kind: privateKey === undefined ? 'password' : 'private-key',
    variable: secret?.envName ?? '',
    keyPath: place?.keyPath ?? '',
  };
}

/** What a stop before login tells about the login: nothing was sent, or used (S17). */
export function loginNotSent(target: Target): string {
  return loginOf(target).kind === 'password'
    ? 'The password was not sent.'
    : 'The key was not used.';
}

/** A connect that failed before login: the host key (S17), the password (S18), the network. */
export function explainBeforeLogin(
  error: TransportError,
  target: Target,
  file: string,
  ci: boolean,
): Explained | undefined {
  const { server, places } = target;
  const nothing = `Nothing was changed on ${target.name}.`;
  switch (error.code) {
    case 'host-key': {
      const expected = target.hostKey;
      const received = error.received;
      if (expected === undefined || received === undefined) return undefined;
      return {
        title: "The server's host key changed. sealup stopped before logging in.",
        details: [
          `${file}${lineOf(places.hostKey ?? {})} expects one key; ${server.host} sent another:`,
          `  expected  ${keyType(expected.type)} ${expected.fingerprint}`,
          `  received  ${keyType(received.type)} ${received.fingerprint}`,
          'Either your host moved the site to a new server, or someone between you',
          'and the server is intercepting the connection.',
          ...changedFixLines('hostKey', target.fromVariables?.hostKey, target.name, file, ci),
        ],
        state: [`${loginNotSent(target)} ${nothing}`],
        slug: 'host-key-changed',
      };
    }
    case 'auth': {
      const login = loginOf(target);
      return {
        title: `Login refused by ${server.host} for user ${server.user}.`,
        details: [
          ...(login.kind === 'password'
            ? [`Check the password in ${login.variable} (${login.keyPath}).`]
            : [
                `Check the key in ${login.variable} (${login.keyPath}): its public key`,
                `must be in ~/.ssh/authorized_keys for ${server.user} on the server.`,
              ]),
          'sealup never retries a refused login: hosts block an IP after failures.',
        ],
        state: [nothing],
        slug: 'login-refused',
      };
    }
    case 'unreachable':
      if (error.reason === 'speaks-ftp') return speaksFtp(error, target, file, nothing);
      return {
        title: `Cannot reach ${server.host}:${server.port}.`,
        details: [
          serverSentence(error, server.host),
          `Check the host and port in ${places.server.keyPath} (${file}${lineWord(places.server)}),`,
          'and that the server is up.',
        ],
        state: [`sealup did not log in. ${nothing}`],
        slug: 'unreachable',
      };
    default:
      return undefined;
  }
}

/**
 * The words of an SSH URL on a port that greets as FTP does (S19, spec #41 decision 9), for every
 * form: what it is (`SFTP` or `SSH`), and the fix. A port the URL names that is not 22 is most
 * likely the slip: remove it. On 22 no port can be removed: the host may offer only FTP (story 15).
 */
export function wrongProtocol(target: Target, file: string) {
  const { server, places } = target;
  const what = server.protocol === 'ssh' ? 'SSH' : 'SFTP';
  const at = `${file}${lineWord(places.server)}`;
  const port = `:${server.port}`;
  const slip = server.port !== 22;
  return {
    what,
    title: `No ${what} server at ${server.host}${port}: this port speaks FTP.`,
    fix: slip
      ? `${what} is usually port 22: remove ${port} from server (${at}).`
      : `If the host offers only FTP, write ftp:// in server (${at}).`,
    summaryFix: slip
      ? `${what} is usually port 22. Remove \`${port}\` from \`server\` (${at}).`
      : `if the host offers only FTP, write \`ftp://\` in \`server\` (${at}).`,
    annotationFix: slip
      ? `${what} is usually port 22: remove ${port} from server in ${file}.`
      : `If the host offers only FTP, write ftp:// in server in ${file}.`,
  };
}

function speaksFtp(
  error: TransportError,
  target: Target,
  file: string,
  nothing: string,
): Explained {
  const words = wrongProtocol(target, file);
  return {
    title: words.title,
    details: [serverSentence(error, target.server.host), words.fix],
    state: [`sealup did not log in. ${nothing}`],
    slug: 'wrong-protocol',
  };
}
