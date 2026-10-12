// The fix of a changed host key or pinned certificate, for the host key and the certificate
// alike, in the log, the annotations and the job summary. Read from a `${NAME}` reference
// (decision 0045 point 7), sealup never writes over it, so the fix is to set the variable, in
// sealup.env and in CI, never to commit sealup.yml: keyscan prints the value to set, and a deploy
// says so. Pure (import rules, pure file): no node: import.

import type { Slug } from './problems.ts';

/** The key of sealup.yml that holds a server's identity. */
export type Pinned = 'hostKey' | 'tlsFingerprint';

/** The docs page of a key or pin read from a variable (host key and certificate alike). */
export const keyInVariable: Slug = 'key-in-variable';

const words = {
  hostKey: { ask: "Ask your host for the server's fingerprint.", what: 'key', shown: 'line' },
  tlsFingerprint: {
    ask: "Ask your host for the certificate's SHA-256.",
    what: 'SHA-256',
    shown: 'value',
  },
} as const;

/** `set SEALUP_HOST_KEY to the new key in sealup.env and in CI`. */
function setVariable(pinned: Pinned, variable: string): string {
  return `set ${variable} to the new ${words[pinned].what} in sealup.env and in CI`;
}

/**
 * The fix of a changed key or pin in one clause, after "Ask your host, then" (annotations): run
 * keyscan and commit, or, read from `variable`, set it (`printedBy`: the keyscan that prints it,
 * for a deploy; keyscan has just printed it).
 */
export function updateClause(
  pinned: Pinned,
  variable: string | undefined,
  target: string,
  printedBy?: 'deploy',
): string {
  if (variable === undefined) return `run sealup keyscan ${target} on your machine`;
  const printed = printedBy === undefined ? '' : ` (sealup keyscan ${target} prints it)`;
  return `${setVariable(pinned, variable)}${printed}`;
}

/** keyscan's last lines for a key or pin read from `variable`: never written, the value to set. */
export function setVariableLines(
  pinned: Pinned,
  file: string,
  variable: string,
  value: string,
): string[] {
  const { ask, shown } = words[pinned];
  return [
    `${file} reads ${pinned} from a variable, which sealup never writes.`,
    `${ask} If it is the received one,`,
    `set ${variable} to this ${shown} in sealup.env and in CI:`,
    `  ${value}`,
  ];
}

/**
 * A deploy's last lines for a changed key or pin: keyscan, then commit `file`; or, read from
 * `variable`, set it (keyscan prints it). `ci`: keyscan runs on the person's machine.
 */
export function changedFixLines(
  pinned: Pinned,
  variable: string | undefined,
  target: string,
  file: string,
  ci: boolean,
): string[] {
  const { ask } = words[pinned];
  if (variable !== undefined) {
    const keyscan = `sealup keyscan ${target}   prints it.`;
    return [
      `${ask} If it is the received one,`,
      `${setVariable(pinned, variable)};`,
      ci ? `on your machine,  ${keyscan}` : `  ${keyscan}`,
    ];
  }
  const keyscan = `sealup keyscan ${target}   then commit ${file}.`;
  return ci
    ? [`${ask} If it is the received one, on`, `your machine:  ${keyscan}`]
    : [`${ask} If it is the received one:`, `  ${keyscan}`];
}

/** The job summary's **Fix:** of a changed key or pin read from `variable`. */
export function variableFixSummary(
  pinned: Pinned,
  variable: string,
  target: string,
  code: (text: string) => string,
): string {
  const ask = words[pinned].ask.charAt(0).toLowerCase() + words[pinned].ask.slice(1);
  return `**Fix:** ${ask} If it is the received one, set ${code(variable)} to the new ${words[pinned].what} in ${code('sealup.env')} and in CI: on your machine, ${code(`sealup keyscan ${target}`)} prints it ([more](https://sealup.dev/e/${keyInVariable})).`;
}
