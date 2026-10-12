// Saving a server's host key into sealup.yml (`sealup keyscan` and `init`, spec #24 decision 18):
// an edit of the text, never a rewrite of the YAML, so the person's comments and layout stay.
// One line changes: the target's old `hostKey:` (its value; a comment after it stays), else init's
// placeholder comment in the target's block, else a new line after the target's `server:`, with
// `server:`'s indentation and the file's line breaks. Every other byte stays. The result is parsed
// again and must give that key, or nothing is written. A value that reads a variable (`${NAME}`,
// plan 06 spec #88 decision 8) is never written over: the edit names the variable instead.

import { readFile, writeFile } from 'node:fs/promises';
import { isMap, isScalar, type Node, type Pair, parseDocument, type YAMLMap } from 'yaml';
import { variablesIn } from './interpolate.ts';

/** What `init` writes in place of the key when it cannot ask (no terminal): keyscan replaces it. */
export const hostKeyPlaceholder = '# hostKey: run sealup keyscan on your computer';

/** The two keys a save writes: an SSH host key, an FTPS certificate's pin. */
export type SavedKey = 'hostKey' | 'tlsFingerprint';

export type HostKeyEdit =
  | { readonly ok: true; readonly text: string; readonly line: number }
  /**
   * The target is not in the file, or not written as an indented block (`{ … }`); or its value
   * reads `variable`, which only the person updates (in sealup.env and in CI).
   */
  | { readonly ok: false; readonly variable?: string };

/** What a save gives: the line that holds the value, or why nothing was written. */
export type SaveResult =
  | { readonly ok: true; readonly line: number }
  | { readonly ok: false; readonly variable?: string };

/**
 * The variable target `name`'s `key` reads in sealup.yml's text (the first, when it reads
 * several), or undefined for a literal, a missing key or target, or a file YAML cannot read. The
 * shorthand's target is the file's top level (`name` is then not read).
 */
export function keyVariable(text: string, name: string, key: SavedKey): string | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;
  const value = doc.contents.has('targets')
    ? doc.getIn(['targets', name, key])
    : doc.contents.get(key);
  return typeof value === 'string' ? variablesIn(value)[0] : undefined;
}

/** keyVariable, read from `file`. */
export async function readKeyVariable(
  file: string,
  name: string,
  key: SavedKey,
): Promise<string | undefined> {
  return keyVariable(await readFile(file, 'utf8'), name, key);
}

/**
 * sealup.yml's text with `keyLine` (`<type> <base64>`) as target `name`'s hostKey, and the
 * 1-based line that holds it. The shorthand's target is the file's top level (`name` is then
 * the shorthand's own name, not read).
 */
export function withHostKey(text: string, name: string, keyLine: string): HostKeyEdit {
  return withLine(text, name, 'hostKey', keyLine);
}

/**
 * sealup.yml's text with `sha256` as target `name`'s tlsFingerprint (an `ftps://` target's pinned
 * certificate, spec #41 decision 12), placed as withHostKey places a host key.
 */
export function withTlsFingerprint(text: string, name: string, sha256: string): HostKeyEdit {
  return withLine(text, name, 'tlsFingerprint', sha256);
}

/** One target key's line, `hostKey` (after init's placeholder, if any) or `tlsFingerprint`. */
function withLine(text: string, name: string, key: SavedKey, value: string): HostKeyEdit {
  const variable = keyVariable(text, name, key);
  if (variable !== undefined) return { ok: false, variable };
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { ok: false };
  const named = doc.contents.has('targets');
  const block = named ? doc.getIn(['targets', name], true) : doc.contents;
  if (!isMap(block) || block.flow === true) return { ok: false };
  const server = pairOf(block, 'server');
  const serverStart = startOf(server?.key);
  const serverEnd = endOf(server?.value);
  if (serverStart === undefined || serverEnd === undefined) return { ok: false };
  const indent = text.slice(text.lastIndexOf('\n', serverStart - 1) + 1, serverStart);
  if (!/^ *$/.test(indent)) return { ok: false };
  const entry = `${key}: ${value}`;

  let edited: { readonly text: string; readonly at: number } | undefined;
  const old = pairOf(block, key);
  if (old !== undefined) {
    const start = startOf(old.key);
    const end = endOf(old.value);
    if (start === undefined || end === undefined) return { ok: false };
    edited = { text: `${text.slice(0, start)}${entry}${text.slice(end)}`, at: start };
  } else {
    const [from, to] = named
      ? targetSpan(doc.getIn(['targets'], true), name, text)
      : [0, text.length];
    const at =
      key === 'hostKey'
        ? placeholderAt(text, from, to, `${indent}${hostKeyPlaceholder}`)
        : undefined;
    if (at !== undefined) {
      const start = at + indent.length;
      const end = start + hostKeyPlaceholder.length;
      edited = { text: `${text.slice(0, start)}${entry}${text.slice(end)}`, at: start };
    } else {
      const lineEnd = text.indexOf('\n', serverEnd);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      edited =
        lineEnd === -1
          ? { text: `${text}${eol}${indent}${entry}`, at: text.length + eol.length + indent.length }
          : {
              text: `${text.slice(0, lineEnd + 1)}${indent}${entry}${eol}${text.slice(lineEnd + 1)}`,
              at: lineEnd + 1 + indent.length,
            };
    }
  }
  if (savedValue(edited.text, named ? name : undefined, key) !== value) return { ok: false };
  return { ok: true, text: edited.text, line: lineAt(edited.text, edited.at) };
}

/**
 * Saves `keyLine` as target `name`'s hostKey in `file` (withHostKey), and says on which line.
 * A file it cannot edit, or a key read from a variable, is left as it was.
 */
export async function saveHostKey(
  file: string,
  name: string,
  keyLine: string,
): Promise<SaveResult> {
  return save(file, withHostKey(await readFile(file, 'utf8'), name, keyLine));
}

/** Saves `sha256` as target `name`'s tlsFingerprint in `file` (withTlsFingerprint). */
export async function saveTlsFingerprint(
  file: string,
  name: string,
  sha256: string,
): Promise<SaveResult> {
  return save(file, withTlsFingerprint(await readFile(file, 'utf8'), name, sha256));
}

async function save(file: string, edit: HostKeyEdit): Promise<SaveResult> {
  if (!edit.ok) return edit;
  await writeFile(file, edit.text);
  return { ok: true, line: edit.line };
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function startOf(node: unknown): number | undefined {
  return isRange(node) ? node.range[0] : undefined;
}

/** Where a value ends (before a comment after it). */
function endOf(node: unknown): number | undefined {
  return isRange(node) ? node.range[1] : undefined;
}

function isRange(node: unknown): node is Node & { range: [number, number, number] } {
  return (
    typeof node === 'object' && node !== null && Array.isArray((node as { range?: unknown }).range)
  );
}

/** The text of target `name`'s block under `targets:`: from its key to the next target's. */
function targetSpan(targets: unknown, name: string, text: string): [number, number] {
  if (!isMap(targets)) return [0, 0];
  const index = targets.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === name);
  const from = startOf(targets.items[index]?.key) ?? 0;
  const to = startOf(targets.items[index + 1]?.key) ?? text.length;
  return [from, to];
}

/** Where a line that is exactly `wanted` (then its line break) starts, between `from` and `to`. */
function placeholderAt(text: string, from: number, to: number, wanted: string): number | undefined {
  let at = text.lastIndexOf('\n', from) + 1;
  while (at < to) {
    const end = text.indexOf('\n', at);
    const line = text.slice(at, end === -1 ? text.length : end).replace(/\r$/, '');
    if (line.trimEnd() === wanted) return at;
    if (end === -1) return undefined;
    at = end + 1;
  }
  return undefined;
}

/** The `key` the text gives target `name` (the top level's without a name), parsed again. */
function savedValue(text: string, name: string | undefined, key: string): unknown {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  return doc.getIn(name === undefined ? [key] : ['targets', name, key]);
}

function lineAt(text: string, at: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return line;
}
