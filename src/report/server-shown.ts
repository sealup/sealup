// What a target that hides a part (decision 0045) must not show in GitHub's form: the values it
// reads from a variable, and what the server showed of itself during the run (a changed host key,
// a certificate other than the pinned one), which gives the server away as well. The log masks
// them (`::add-mask::`); the job summary replaces them itself. Pure (import rules, pure file).

import {
  type HostKeyCheck,
  type Problem,
  revealingValues,
  type Target,
} from '../contracts/index.ts';
import { formatServer } from './format.ts';

/** Whether the target reads a part from a variable: then all it shows of its server is hidden. */
export function hidesServer(target: Target | undefined): target is Target {
  return target?.fromVariables !== undefined;
}

/**
 * What a server showed of itself that sealup.yml does not hold: a changed host key, a
 * certificate other than the pinned one. A saved key or pin is masked already when read from a
 * variable, and in plain text in the file otherwise.
 */
export function shownIdentity(check: HostKeyCheck | undefined, target: Target): string[] {
  if (check?.state === 'changed') return revealingValues({ hostKey: check.received });
  if (check?.state === 'certificate' && check.certificate.sha256 !== target.tlsFingerprint) {
    return revealingValues({ certificate: check.certificate.sha256 });
  }
  return [];
}

/** The server identity a problem names (a key or a certificate, met on a reconnect too). */
export function identityOf(problem: Problem | undefined): HostKeyCheck | undefined {
  if (problem?.code !== 'transport') return undefined;
  const { received, certificate } = problem.error;
  if (received !== undefined) return { state: 'changed', received };
  if (certificate !== undefined) return { state: 'certificate', certificate, check: 'refused' };
  return undefined;
}

/**
 * The values the target reads from a variable, as the run's words print them: the server (as
 * sealup writes it back, its user and host), the host key, the pinned certificate.
 */
export function fromVariableValues(target: Target): string[] {
  const from = target.fromVariables ?? {};
  const { server, hostKey, tlsFingerprint } = target;
  return [
    ...(from.server === undefined
      ? []
      : revealingValues({ server: formatServer(server), url: server })),
    ...(from.hostKey === undefined || hostKey === undefined ? [] : revealingValues({ hostKey })),
    ...(from.tlsFingerprint === undefined || tlsFingerprint === undefined
      ? []
      : revealingValues({ certificate: tlsFingerprint })),
  ];
}
