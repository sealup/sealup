// The leak-test harness (R1, decision 0013): canary secrets that CLI tests put in the
// environment, and a search for every form of them in what a run left behind: stdout, stderr,
// the JSON object, the files written to the server (the manifest included).
//
// Forms searched, for each canary and for each line (≥ 6 characters) of a multi-line one:
// raw, JSON-escaped, URL-encoded (encodeURIComponent and form encoding), base64 and base64url
// at all three byte alignments (so `user:password` in base64 is found too), hex in both cases.
// A failure names the canary's variable, the place and the form, never the value.

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
