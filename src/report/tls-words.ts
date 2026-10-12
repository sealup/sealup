// The words of an FTPS connect that stopped on TLS (R8, spec #41 decision 8), before the login:
// the server refused AUTH TLS, or its certificate is not trusted, names another host, or is not
// the pinned one. In every form: the log's lines, GitHub's annotation, the job summary's box.
// Pure (import rules, pure file): no node: import.

import type { ServerCertificate, Target, TransportError } from '../contracts/index.ts';
import { lineOf, lineWord, printable } from './format.ts';
import { loginNotSent } from './login-words.ts';
import type { Explained } from './problems.ts';
import { serverSentence } from './server-words.ts';
import { changedFixLines, updateClause, variableFixSummary } from './variable-words.ts';

/** The certificate's lines: what to compare with what the host says. */
export function certificateFacts(certificate: ServerCertificate): string[] {
  const day = (iso: string): string => iso.slice(0, 10);
  return [
    `  subject  ${printable(certificate.subject)}`,
    `  issuer   ${printable(certificate.issuer)}`,
    `  valid    ${day(certificate.validFrom)} to ${day(certificate.validTo)}`,
    `  SHA-256  ${certificate.sha256}`,
  ];
}

/** The variable the pin is read from (decision 0045): the fix sets it, never commits the file. */
function pinVariable(target: Target): string | undefined {
  return target.fromVariables?.tlsFingerprint;
}

/** Short titles, for the annotation and the summary. */
function shortTitle(error: TransportError): string {
  switch (error.reason) {
    case 'tls-refused':
      return 'TLS refused';
    case 'certificate-other':
      return 'TLS certificate changed';
    case 'certificate-name':
      return 'TLS certificate for another host';
    default:
      return 'TLS certificate not trusted';
  }
}

/** The log's words; undefined for an error that is not TLS's. */
export function explainTls(
  error: TransportError,
  target: Target,
  file: string,
  ci: boolean,
): Explained | undefined {
  if (error.code !== 'tls') return undefined;
  const { server, places } = target;
  const state = [`${loginNotSent(target)} Nothing was changed on ${target.name}.`];
  const before = 'sealup stopped before logging in.';
  if (error.reason === 'tls-refused') {
    return {
      title: `${server.host} refused TLS. ${before}`,
      details: [
        serverSentence(error, server.host),
        'sealup never falls back to plain FTP. Check the port in server',
        `(${file}${lineWord(places.server)}): FTPS here is explicit TLS, usually on port 21.`,
      ],
      state,
      slug: 'tls-refused',
    };
  }
  const { certificate } = error;
  if (certificate === undefined) return undefined;
  const command = `sealup keyscan ${target.name}`;
  if (error.reason === 'certificate-other') {
    return {
      title: `The server's TLS certificate changed. ${before}`,
      details: [
        `${file}${lineOf(places.tlsFingerprint ?? {})} pins one certificate; ${server.host} showed another:`,
        `  expected  SHA-256 ${target.tlsFingerprint ?? ''}`,
        `  received  SHA-256 ${certificate.sha256}`,
        'Either your host renewed or replaced its certificate, or someone between',
        'you and the server is intercepting the connection.',
        ...changedFixLines('tlsFingerprint', pinVariable(target), target.name, file, ci),
      ],
      state,
      slug: 'certificate-refused',
    };
  }
  const what = error.reason === 'certificate-name' ? 'names another host' : 'is not trusted';
  return {
    title: `The server's TLS certificate ${what}. ${before}`,
    details: [
      serverSentence(error, server.host),
      ...certificateFacts(certificate),
      ci
        ? 'If your host confirms this certificate (ask for its SHA-256), pin it on'
        : 'If your host confirms this certificate (ask for its SHA-256), pin it:',
      ci
        ? `your machine:  ${command}   then commit ${file}.`
        : `  ${command}   then commit ${file}.`,
    ],
    state,
    slug: 'certificate-refused',
  };
}

/** GitHub's annotation: one line, at the line to change. */
export function tlsAnnotation(
  error: TransportError,
  target: Target,
  file: string,
): { title: string; message: string; place: 'server' | 'tlsFingerprint' } | undefined {
  if (error.code !== 'tls') return undefined;
  const { server } = target;
  const sha = error.certificate === undefined ? '' : ` (SHA-256 ${error.certificate.sha256})`;
  const tail = `${loginNotSent(target)} Nothing was changed on ${target.name}.`;
  if (error.reason === 'tls-refused') {
    return {
      title: shortTitle(error),
      message: `${server.host} refused TLS (AUTH TLS). sealup never falls back to plain FTP: check the port in server in ${file}. ${tail}`,
      place: 'server',
    };
  }
  const variable = pinVariable(target);
  const fix =
    variable === undefined
      ? `If your host confirms it, run sealup keyscan ${target.name} on your machine and commit ${file}.`
      : `Ask your host, then ${updateClause('tlsFingerprint', variable, target.name, 'deploy')}.`;
  return {
    title: shortTitle(error),
    message: `${serverSentence(error, server.host)}${sha} ${fix} ${tail}`,
    place: error.reason === 'certificate-other' ? 'tlsFingerprint' : 'server',
  };
}

/** The job summary's title and box. */
export function tlsSummary(
  error: TransportError,
  target: Target,
  file: string,
  code: (text: string) => string,
): { title: string; box: string[] } | undefined {
  if (error.code !== 'tls') return undefined;
  const { server } = target;
  const not = loginNotSent(target);
  const stopped = `sealup stopped before logging in; ${not.charAt(0).toLowerCase()}${not.slice(1)}`;
  if (error.reason === 'tls-refused') {
    return {
      title: shortTitle(error),
      box: [
        `${code(server.host)} refused TLS (\`AUTH TLS\`). ${stopped} sealup never falls back to plain FTP.`,
        `**Fix:** check the port in ${code('server')} (${file}): FTPS here is explicit TLS, usually on port 21.`,
      ],
    };
  }
  const sha = error.certificate === undefined ? '' : ` SHA-256 ${code(error.certificate.sha256)}.`;
  const variable = pinVariable(target);
  return {
    title: shortTitle(error),
    box: [
      `${serverSentence(error, server.host)}${sha} ${stopped}`,
      variable === undefined
        ? `**Fix:** if your host confirms this certificate, run ${code(`sealup keyscan ${target.name}`)} on your machine and commit ${code(file)}.`
        : variableFixSummary('tlsFingerprint', variable, target.name, code),
    ],
  };
}
