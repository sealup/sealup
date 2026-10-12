// The leak-test harness (R1, decision 0013): canary secrets that CLI tests put in the
// environment, and a search for every form of them in what a run left behind: stdout, stderr,
// the JSON object, the files written to the server (the manifest included).
//
// Forms searched, for each canary and for each line (≥ 6 characters) of a multi-line one:
// raw, JSON-escaped, URL-encoded (encodeURIComponent and form encoding), base64 and base64url
// at all three byte alignments (so `user:password` in base64 is found too), hex in both cases.
// A failure names the canary's variable, the place and the form, never the value.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { userKey } from './keys.ts';

/**
 * The canary login key. A child process (cli-kit) gets it in its environment, so it holds the
 * same one; a canary another process made is never searched for.
 */
const canaryKey = userKey();

/**
 * The canary secrets, as environment variables. Together they hold `" ' $ / + = % \` and a
 * newline. The password has no line break, so a login can use it (R4 refuses CR, LF and NUL).
 * The key is a real login key, made fresh in this process (test-only, decision 0033): a
 * multi-line secret a login can use, whose every line is searched for.
 */
export const canaries: Readonly<{
  SEALUP_CANARY_PASSWORD: string;
  SEALUP_CANARY_MULTILINE: string;
  SEALUP_CANARY_KEY: string;
}> = {
  SEALUP_CANARY_PASSWORD: `Cn4ry-pw"'$/+=%\\x7Qz-fake`,
  SEALUP_CANARY_MULTILINE: `Cn4ry-first"'$/+=%\\line\nCn4ry-second-line-fake`,
  SEALUP_CANARY_KEY: canaryKey.private,
};

/** The canary key's authorized_keys line, for a server that must accept it. */
export const canaryKeyLine: string = canaryKey.publicLine;

/** What a run left behind, by place: text, bytes (a Uint8Array), or a parsed JSON value. */
type Places = Readonly<Record<string, unknown>>;

interface Leak {
  /** The variable that holds the canary. */
  readonly canary: string;
  readonly place: string;
  readonly form: string;
}

interface Form {
  readonly name: string;
  readonly text: string;
}

/** The base64 characters that depend only on `secret` when it starts `offset` bytes in. */
function base64Core(secret: Buffer, offset: number, encoding: 'base64' | 'base64url'): string {
  const encoded = Buffer.concat([Buffer.alloc(offset), secret]).toString(encoding);
  const start = Math.ceil((offset * 8) / 6);
  const end = Math.floor(((offset + secret.length) * 8) / 6);
  return encoded.slice(start, end);
}

function formsOf(value: string): Form[] {
  const bytes = Buffer.from(value, 'utf8');
  const hex = bytes.toString('hex');
  const forms: Form[] = [
    { name: 'raw', text: value },
    { name: 'JSON-escaped', text: JSON.stringify(value).slice(1, -1) },
    { name: 'URL-encoded', text: encodeURIComponent(value) },
    { name: 'form-encoded', text: new URLSearchParams({ x: value }).toString().slice(2) },
    { name: 'hex', text: hex },
    { name: 'hex', text: hex.toUpperCase() },
  ];
  for (const encoding of ['base64', 'base64url'] as const) {
    for (const offset of [0, 1, 2]) {
      forms.push({ name: encoding, text: base64Core(bytes, offset, encoding) });
    }
  }
  return forms;
}

/** Every form of a canary, one line at a time for a multi-line one. */
function canaryForms(value: string): Form[] {
  const lines = value.split(/\r?\n/);
  const forms = formsOf(value);
  if (lines.length > 1) {
    lines.forEach((line, i) => {
      if (line.length < 6) return;
      for (const form of formsOf(line))
        forms.push({ name: `line ${i + 1}, ${form.name}`, text: form.text });
    });
  }
  return forms;
}

/** The texts to search in one place: a JSON value is searched string by string. */
function textsOf(content: unknown): (string | Uint8Array)[] {
  if (typeof content === 'string' || content instanceof Uint8Array) return [content];
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        texts.push(key);
        walk(item);
      }
    }
  };
  walk(content);
  return texts;
}

const contains = (haystack: string | Uint8Array, needle: string): boolean =>
  typeof haystack === 'string'
    ? haystack.includes(needle)
    : Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle);

/** Every canary form found in the places, at most one leak per canary, place and form name. */
export function findLeaks(
  places: Places,
  secrets: Readonly<Record<string, string>> = canaries,
): Leak[] {
  const leaks: Leak[] = [];
  for (const [canary, value] of Object.entries(secrets)) {
    const forms = canaryForms(value);
    for (const [place, content] of Object.entries(places)) {
      const texts = textsOf(content);
      const found = new Set<string>();
      for (const form of forms) {
        if (found.has(form.name)) continue;
        if (texts.some((text) => contains(text, form.text))) {
          found.add(form.name);
          leaks.push({ canary, place, form: form.name });
        }
      }
    }
  }
  return leaks;
}

/** Throws when a canary shows anywhere in the places; the message names no value. */
export function expectNoLeaks(places: Places): void {
  const leaks = findLeaks(places);
  if (leaks.length === 0) return;
  const lines = leaks.map((leak) => `${leak.canary} leaked in ${leak.place} as ${leak.form}`);
  throw new Error(`secret leak (R1):\n${lines.join('\n')}`);
}

/**
 * A GitHub-form log cut in two (R2, spec #24 decision 30): the `::add-mask::` lines it starts
 * with, the one place a secret may be written, and the rest, where none may be. A mask line after
 * any other line belongs to the rest: masks come before any other byte or not at all.
 */
export function splitMasks(log: string): { readonly masks: string; readonly rest: string } {
  const lines = log.split('\n');
  const first = lines.findIndex((line) => !line.startsWith('::add-mask::'));
  const end = first === -1 ? lines.length : first;
  return { masks: lines.slice(0, end).join('\n'), rest: lines.slice(end).join('\n') };
}

/** The canary host key of a hidden server: a real key line, made fresh in this process. */
const hiddenHostKey = userKey().publicLine;
const hiddenFingerprint = `SHA256:${createHash('sha256')
  .update(Buffer.from(hiddenHostKey.split(' ')[1] ?? '', 'base64'))
  .digest('base64')
  .replace(/=+$/, '')}`;

/**
 * The canary server and host key of a public repository (decision 0045), as environment
 * variables, for a config that reads them (`server: ${SEALUP_CANARY_SERVER}`). Not secrets: a
 * terminal shows them whole (R22); GitHub's form masks them, and the job summary never holds
 * them. A memory server shows the key with `createMemoryServer({ hostKeyLine })`.
 */
export const hiddenCanaries: Readonly<{
  SEALUP_CANARY_SERVER: string;
  SEALUP_CANARY_HOST_KEY: string;
}> = {
  SEALUP_CANARY_SERVER: 'sftp://cn4ry-user@cn4ry-host.example.com/home/site',
  SEALUP_CANARY_HOST_KEY: hiddenHostKey,
};

/** Each hidden canary and the parts of it a run prints alone, searched in every form. */
const hiddenParts: Readonly<Record<string, string>> = {
  ...hiddenCanaries,
  'SEALUP_CANARY_SERVER (user)': 'cn4ry-user',
  'SEALUP_CANARY_SERVER (host)': 'cn4ry-host.example.com',
  'SEALUP_CANARY_HOST_KEY (fingerprint)': hiddenFingerprint,
};

const maskCommand = '::add-mask::';

/** The value a `::add-mask::` line registers, GitHub's escapes read back. */
function maskedValue(line: string): string {
  return line
    .slice(maskCommand.length)
    .replaceAll('%0D', '\r')
    .replaceAll('%0A', '\n')
    .replaceAll('%25', '%');
}

/** A text with each value replaced by `***`, longest first. */
function hideAll(text: string, values: readonly string[]): string {
  const longest = values.filter((value) => value !== '').sort((a, b) => b.length - a.length);
  return longest.reduce((shown, value) => shown.replaceAll(value, '***'), text);
}

/**
 * What GitHub shows of a text once every `::add-mask::` line of a GitHub-form log is registered,
 * the leading ones and any later one: each value replaced by `***`. For a text written once
 * the run is over (the `--json` object), or a log whose masks all lead it; `githubLog` reads a
 * log with later masks line by line. For the hidden canaries only: a secret sealup redacts
 * itself, and is checked without masks.
 */
export function githubMasks(log: string): (text: string) => string {
  const values = log
    .split('\n')
    .filter((line) => line.startsWith(maskCommand))
    .map(maskedValue);
  return (text) => hideAll(text, values);
}

/**
 * A GitHub-form log after its leading masks, as GitHub shows it: a mask line later in the log
 * (a key the server showed, decision 0045) hides its value from the lines after it only, and
 * is not shown itself. The leading masks hide their values everywhere.
 */
export function githubLog(log: string): string {
  const { masks, rest } = splitMasks(log);
  const values = masks === '' ? [] : masks.split('\n').map(maskedValue);
  const shown: string[] = [];
  for (const line of rest.split('\n')) {
    if (line.startsWith(maskCommand)) values.push(maskedValue(line));
    else shown.push(hideAll(line, values));
  }
  return shown.join('\n');
}

/**
 * Throws when a hidden canary, or its user, host or fingerprint, shows in a place (decision
 * 0045): a GitHub-form log once read through `githubLog` or `githubMasks`, or the job summary as
 * it is. `also`: more values the run must hide, by name (a key the test's server shows). The
 * message names the canary, never its value.
 */
export function expectHiddenMasked(
  places: Places,
  also: Readonly<Record<string, string>> = {},
): void {
  const leaks = findLeaks(places, { ...hiddenParts, ...also });
  if (leaks.length === 0) return;
  const lines = leaks.map((leak) => `${leak.canary} unmasked in ${leak.place} as ${leak.form}`);
  throw new Error(`hidden server leak (decision 0045):\n${lines.join('\n')}`);
}

/** The files under a folder (a server's root on disk), keyed by `/`-separated relative path. */
export async function readTree(folder: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files[relative(folder, full).split(sep).join('/')] = await readFile(full);
  }
  return files;
}
