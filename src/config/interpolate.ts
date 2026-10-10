// Variables in sealup.yml (decisions 0012, 0022 §6), Compose style: `${NAME}`, `${NAME:?message}`
// (stop with this message when unset) and `$$` for one literal `$`. Applied after parsing, to
// string values only, so a value can never add YAML. Every other `$` form is refused at its place
// rather than guessed. An empty variable counts as not set (GitHub passes empty secrets).

import type { Env } from './env.ts';

const name = '[A-Za-z_][A-Za-z0-9_]*';
/** One token: `$$`, or a reference with its optional `:?message`, or any other `$`. */
const token = new RegExp(`\\$(?:\\$|\\{(${name})(?::\\?([^}]*))?\\}|)`, 'g');
/** A whole value that is one reference: the only form a password may take (R3). */
const wholeReference = new RegExp(`^\\$\\{(${name})(?::\\?([^}]*))?\\}$`);

export interface Reference {
  readonly variable: string;
  /** The `:?message`, when the config gives one. */
  readonly message?: string;
}

export type Interpolated =
  | { readonly ok: true; readonly value: string }
  | ({ readonly ok: false } & Reference);

/** Whether `text` uses only the forms sealup reads; false for `$NAME`, a lone `$`, `${A:-b}`. */
export function validSyntax(text: string): boolean {
  for (const match of text.matchAll(token)) {
    if (match[0] === '$') return false;
  }
  return true;
}

/** `text` as one reference (`${NAME}` or `${NAME:?message}`), or undefined. */
export function referenceOf(text: string): Reference | undefined {
  const match = wholeReference.exec(text);
  const variable = match?.[1];
  if (variable === undefined) return undefined;
  return withMessage(variable, match?.[2]);
}

/** The variables `text` reads, in order, each once. Syntax checked first. */
export function variablesIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(token)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names];
}

/** `text` with its variables filled in; the first unset one when any is. Syntax checked first. */
export function interpolate(text: string, env: Env): Interpolated {
  let missing: Reference | undefined;
  const value = text.replace(token, (whole, variable: string | undefined, message?: string) => {
    if (whole === '$$') return '$';
    if (variable === undefined) throw new RangeError('interpolate() needs valid syntax');
    const found = Object.hasOwn(env, variable) ? env[variable] : undefined;
    if (typeof found !== 'string' || found === '') {
      missing ??= withMessage(variable, message);
      return '';
    }
    return found;
  });
  return missing === undefined ? { ok: true, value } : { ok: false, ...missing };
}

function withMessage(variable: string, message: string | undefined): Reference {
  return message === undefined || message === '' ? { variable } : { variable, message };
}
