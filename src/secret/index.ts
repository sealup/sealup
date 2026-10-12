// secret: how secrets stay out of every output (R1, R2, R4, decision 0019).
//
// Decision hidden: the opaque Secret value, its derived forms, and redaction of text.
//
// Interface: createSecret(envName, value) wraps a credential as a Secret or refuses it;
// createFileSecret(envName, value) wraps the content of a file written from a secret (R17: line
// breaks allowed); reveal() it (transport and testkit only, enforced by the import rules);
// secretSize() and sameAsSecret(secret, bytes) compare it with a server file read back, without
// giving it out; redact() text for the one output sink, report; secretForms(secrets) for
// GitHub's mask lines (report only, enforced by the import rules).
//
// Invariants: a Secret prints as `[secret]` through toString, toJSON and util.inspect, and the
// object holds no copy of its value (the value lives in a module-private WeakMap). A credential
// that has CR, LF or NUL, or starts or ends with whitespace is refused (R4), and so is one under
// `shortestSecret` characters (contracts; R2: too short to mask; the empty value included). Every
// Secret made in this process is known to redact(), with its derived forms (base64, base64url,
// URL-encoded, JSON-escaped, hex), and for a multi-line value each line of 6 characters or more
// with its forms too: nothing has to remember to register it.
//
// Must never know: where a secret comes from (config, env) or where it goes (transport, report).

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { type Secret, shortestSecret } from '../contracts/index.ts';

const shown = '[secret]';

/** Why a credential is refused; the value itself is never part of the answer (R6). */
type CredentialProblem = 'forbidden-character' | 'surrounding-whitespace' | 'too-short';

type SecretResult =
  | { readonly ok: true; readonly secret: Secret }
  | { readonly ok: false; readonly problem: CredentialProblem };

const values = new WeakMap<Secret, string>();
/** Every form of every secret made so far, longest first, so a longer form masks first. */
let forms: readonly string[] = [];

class OpaqueSecret implements Secret {
  readonly envName: string;

  constructor(envName: string) {
    this.envName = envName;
    Object.freeze(this);
  }

  toString(): string {
    return shown;
  }

  toJSON(): string {
    return shown;
  }

  [Symbol.toPrimitive](): string {
    return shown;
  }

  // util.inspect (console.log, util.format %o/%O) calls this instead of listing fields.
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return shown;
  }
}

/**
 * Wraps a credential as a Secret, or refuses it: R4 (CR, LF and NUL would inject lines), then
 * R2 (a value under 6 characters, counted in code points, is too short to mask).
 */
export function createSecret(envName: string, value: string): SecretResult {
  if (/[\r\n\0]/.test(value)) return { ok: false, problem: 'forbidden-character' };
  if (value.trim() !== value) return { ok: false, problem: 'surrounding-whitespace' };
  if ([...value].length < shortestSecret) return { ok: false, problem: 'too-short' };
  const secret = new OpaqueSecret(envName);
  values.set(secret, value);
  remember(value);
  return { ok: true, secret };
}

/**
 * Wraps the content of a file written from a secret (R17): line breaks allowed (R4 is for
 * credentials), at least `shortestSecret` characters in all (R2). Redaction and the masks cover
 * the whole value and each of its lines of 6 characters or more (spec #24 decision 24), each
 * line without the spaces at its ends.
 */
export function createFileSecret(envName: string, value: string): SecretResult {
  if ([...value].length < shortestSecret) return { ok: false, problem: 'too-short' };
  const secret = new OpaqueSecret(envName);
  values.set(secret, value);
  remember(value);
  return { ok: true, secret };
}

/** The size of a Secret's value in bytes (UTF-8, as it is written): how much to read back. */
export function secretSize(secret: Secret): number {
  return Buffer.byteLength(heldValue(secret), 'utf8');
}

/** Whether bytes read back from a server are exactly a Secret's value, without giving it out. */
export function sameAsSecret(secret: Secret, bytes: Uint8Array): boolean {
  const value = Buffer.from(heldValue(secret), 'utf8');
  return value.length === bytes.length && timingSafeEqual(value, bytes);
}

/** The value of a Secret. Only `transport` may call this (import rule reveal-only-transport). */
export function reveal(secret: Secret): string {
  return heldValue(secret);
}

function heldValue(secret: Secret): string {
  const value = values.get(secret);
  if (value === undefined) throw new TypeError('not a Secret made by createSecret()');
  return value;
}

/** Text with every known secret, in each derived form, replaced by `[secret]` (R1). */
export function redact(text: string): string {
  let out = text;
  for (const form of forms) out = out.replaceAll(form, shown);
  return out;
}

/**
 * The value of each Secret and each of its derived forms, once each, in order: what GitHub's
 * `::add-mask::` lines register before anything else is printed (R2). Only report may call this
 * (import rule forms-only-report): its mask lines are the one place a secret is written. Then
 * the `hidden` values (decision 0045: a server or host key read from a variable), masked like a
 * secret in GitHub's form but never redacted, so a terminal shows them; one under
 * `shortestSecret` characters is masked as it is only, as its encodings would hide too much.
 */
export function secretForms(secrets: readonly Secret[], hidden: readonly string[] = []): string[] {
  return [
    ...new Set([
      ...secrets.flatMap((secret) => allForms(heldValue(secret))),
      ...hidden.flatMap((value) =>
        [...value].length < shortestSecret ? [value] : derivedForms(value),
      ),
    ]),
  ];
}

/** The forms of a value, then those of each of its lines of 6 characters or more. */
function allForms(value: string): string[] {
  return [value, ...maskedLines(value)].flatMap(derivedForms);
}

/**
 * The lines of a multi-line value long enough to mask (R2), without the spaces at their ends:
 * a line shows up on its own in a log. None for a one-line value.
 */
function maskedLines(value: string): string[] {
  const lines = value.split(/\r?\n/);
  if (lines.length < 2) return [];
  return lines.map((line) => line.trim()).filter((line) => [...line].length >= shortestSecret);
}

function derivedForms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const hex = bytes.toString('hex');
  return [
    value,
    bytes.toString('base64'),
    bytes.toString('base64url'),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    hex,
    hex.toUpperCase(),
  ];
}

function remember(value: string): void {
  forms = [...new Set([...forms, ...allForms(value)])].sort((a, b) => b.length - a.length);
}
