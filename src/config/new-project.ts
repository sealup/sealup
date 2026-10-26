// What `sealup init` writes that config owns (spec #24 decision 19): the minimal sealup.yml
// (exploration 06 §2.1, four lines; the sam-sync conversion adds its upload entries, scoped
// excludes and pull) and the variables' lines in sealup.env. Both are read back
// here before they are given out: the YAML by the YAML parser, the env line by the env-file
// reader (util.parseEnv), so what init writes is exactly what a deploy reads.

import { isDeepStrictEqual, parseEnv } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import type { Secret } from '../contracts/index.ts';
import { createFileSecret, createSecret } from '../secret/index.ts';
import { hostKeyPlaceholder } from './save-host-key.ts';

/** The variable init's sealup.yml names for the password (0022 §6). */
export const passwordVariable = 'SEALUP_PASSWORD';

/** The variables a public repository's sealup.yml names for the server and its host key (0045). */
export const serverVariable = 'SEALUP_SERVER';
export const hostKeyVariable = 'SEALUP_HOST_KEY';

type UploadDestination =
  | string
  | { readonly to: string; readonly mirror?: boolean; readonly exclude?: readonly string[] };

/** What a new sealup.yml holds: one target, the shorthand. */
export interface NewConfig {
  readonly server: string;
  readonly hostKey?: string;
  /**
   * A public repository (0045): `server` and `hostKey` are written as `${SEALUP_SERVER}` and
   * `${SEALUP_HOST_KEY}`, their values going to sealup.env (init's EnvValue).
   */
  readonly publicRepo?: boolean;
  /** One folder (`upload: dist`), or `local: remote` pairs. */
  readonly upload:
    | string
    | readonly (readonly [
        local: string,
        remote: UploadDestination | readonly UploadDestination[],
      ])[];
  readonly exclude?: readonly string[];
  /** `remote: ${VARIABLE}` pairs: files written from a secret. */
  readonly write?: readonly (readonly [remote: string, variable: string])[];
  /** `remote: local` pairs, for sealup pull. */
  readonly pull?: readonly (readonly [remote: string, local: string])[];
}

/**
 * sealup.yml for one target: `server`, `password` from `${SEALUP_PASSWORD}`, `hostKey` (the
 * placeholder comment when none; nothing for `ftp://` and `ftps://`, which have no host key),
 * `upload`, then `exclude`, `write` and `pull` when given (the sam-sync conversion);
 * `publicRepo`: the server and the host key as references (0045). A value YAML would read
 * otherwise is quoted. The text is read back by the YAML parser and must give exactly these
 * facts.
 */
export function newConfigText(facts: NewConfig): string {
  const pairs = (key: string, list: readonly (readonly [string, string])[]): string[] =>
    list.length === 0 ? [] : [`${key}:`, ...list.map(([from, to]) => `  ${scalar(from)}: ${to}`)];
  const write = facts.write ?? [];
  const pull = facts.pull ?? [];
  const exclude = facts.exclude ?? [];
  // FTP and FTPS have no host key: no placeholder to fill in (spec #41 decision 10).
  const ftp = /^ftps?:\/\//.test(facts.server);
  const references = facts.publicRepo === true;
  const server = references ? `$\{${serverVariable}}` : facts.server;
  const hostKey =
    facts.hostKey === undefined || !references ? facts.hostKey : `$\{${hostKeyVariable}}`;
  const lines = [
    `server: ${scalar(server)}`,
    `password: $\{${passwordVariable}}`,
    ...(hostKey !== undefined ? [`hostKey: ${scalar(hostKey)}`] : ftp ? [] : [hostKeyPlaceholder]),
    ...(typeof facts.upload === 'string'
      ? [`upload: ${scalar(facts.upload)}`]
      : facts.upload.length === 0
        ? ['upload: {}']
        : [stringify({ upload: Object.fromEntries(facts.upload) }, { lineWidth: 0 }).trimEnd()]),
    ...(exclude.length === 0
      ? []
      : ['exclude:', ...exclude.map((pattern) => `  - ${scalar(pattern)}`)]),
    ...pairs(
      'write',
      write.map(([remote, variable]) => [remote, `$\{${variable}}`]),
    ),
    ...pairs(
      'pull',
      pull.map(([remote, local]) => [remote, scalar(local)]),
    ),
    '',
  ];
  const text = lines.join('\n');
  const read = parseDocument(text).toJS() as Record<string, unknown>;
  const expected = {
    server,
    password: `$\{${passwordVariable}}`,
    ...(hostKey === undefined ? {} : { hostKey }),
    upload: typeof facts.upload === 'string' ? facts.upload : Object.fromEntries(facts.upload),
    ...(exclude.length === 0 ? {} : { exclude }),
    ...(write.length === 0
      ? {}
      : {
          write: Object.fromEntries(write.map(([remote, variable]) => [remote, `$\{${variable}}`])),
        }),
    ...(pull.length === 0 ? {} : { pull: Object.fromEntries(pull) }),
  };
  if (!isDeepStrictEqual(read, expected)) {
    throw new Error('the new sealup.yml does not read back as written');
  }
  return text;
}

/** One YAML scalar on one line: plain when YAML reads it back as written, else quoted. */
function scalar(value: string): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

/**
 * Why a value cannot go in sealup.env. `too-short`, `surrounding-whitespace`,
 * `forbidden-character`: a password (or a file's content) sealup would refuse when it reads it
 * (R2, R4). `cannot-quote`: no form the env-file reader gives back.
 */
type EnvRefusal = 'too-short' | 'surrounding-whitespace' | 'forbidden-character' | 'cannot-quote';

/** A value made a Secret for sealup.env, or why it cannot go there. */
export type EnvSecret =
  | { readonly ok: true; readonly secret: Secret }
  | { readonly ok: false; readonly reason: EnvRefusal };

type EnvEdit =
  /** `added`: false when the file already sets the variable (then `text` is as it was). */
  | { readonly ok: true; readonly text: string; readonly added: boolean }
  | { readonly ok: false; readonly reason: 'cannot-quote' };

/**
 * The value of each Secret made by envSecret, held here alone: config writes it into sealup.env,
 * as it reads it from there. Everyone else holds the opaque Secret (only transport reveals one).
 */
const envValues = new WeakMap<Secret, string>();

/**
 * A value bound for sealup.env (a password typed or found in a sam-sync file, or a CI-provided
 * file secret), made a Secret the moment it is read: from then on redaction and GitHub's
 * masks know it (R1, R2). Checked as a password is, or with `kind: 'file'` as a file's content
 * written from a secret (line breaks allowed, R17), and refused when no line of an env file can
 * hold it.
 */
export function envSecret(
  name: string,
  value: string,
  kind: 'password' | 'file' = 'password',
): EnvSecret {
  const checked = kind === 'file' ? createFileSecret(name, value) : createSecret(name, value);
  if (!checked.ok) return { ok: false, reason: checked.problem };
  envValues.set(checked.secret, value);
  const line = withEnvVariable('', checked.secret);
  return line.ok ? { ok: true, secret: checked.secret } : line;
}

/**
 * A value bound for sealup.env that is not a secret: a public repository's server or host key
 * (0045). It stays a plain value: never redacted, never masked.
 */
export interface EnvValue {
  readonly envName: string;
  readonly value: string;
}

/**
 * An env file's text with the variable (`envName=value`) added on a line of its own, in the first
 * form the env-file reader gives back exactly (single quotes, backticks, double quotes, bare). A
 * file that already sets the variable (not empty) is left as it is. A Secret comes from
 * envSecret; an EnvValue holds its value.
 */
export function withEnvVariable(text: string, variable: Secret | EnvValue): EnvEdit {
  const name = variable.envName;
  const value = 'value' in variable ? variable.value : envValues.get(variable);
  if (value === undefined) throw new TypeError('not a Secret made by envSecret()');
  const before = parseEnv(text);
  const set = before[name];
  if (set !== undefined && set !== '') return { ok: true, text, added: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const start = text === '' || text.endsWith('\n') ? text : `${text}${eol}`;
  for (const quote of ["'", '`', '"', '']) {
    const edited = `${start}${name}=${quote}${value}${quote}${eol}`;
    const read = parseEnv(edited);
    const others = Object.keys(before).every((key) => key === name || read[key] === before[key]);
    if (read[name] === value && others) return { ok: true, text: edited, added: true };
  }
  return { ok: false, reason: 'cannot-quote' };
}
