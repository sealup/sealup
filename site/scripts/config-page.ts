// The config page, built from schema.json at each build (spec sealup/sealup#41 decision 40,
// I-098): one section per key of sealup.yml, so the site never drifts from what sealup accepts.
// A key the schema gains gets its section with no change here. A key with no description in the
// schema takes its line from `sealup help config`.
//
//   node scripts/config-page.ts    writes src/content/docs/config.md (git-ignored)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpLines } from '../../src/report/help.ts';

interface SchemaNode {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: SchemaNode | boolean;
  readonly items?: SchemaNode;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly SchemaNode[];
  readonly minimum?: number;
  readonly maximum?: number;
}

interface Key {
  readonly node: SchemaNode;
  readonly places: string[];
  readonly requiredIn: string[];
}

const oneTarget = 'top level (one target)';
const shared = 'top level (several targets: for all of them)';
const inTarget = 'in a target (`targets.<name>`)';

/** The key lines of `sealup help config` (`  server           sftp://…`), by key. */
function helpWords(): Map<string, string> {
  const words = new Map<string, string>();
  for (const line of helpLines('config')) {
    const text = line.map((part) => (typeof part === 'string' ? part : part.text)).join('');
    const match = /^ {2}(\w+) {2,}(\S.*)$/.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) words.set(match[1], match[2]);
  }
  return words;
}

/** The keys of every form of the file, in the schema's order, each with where it may go. */
function collectKeys(schema: SchemaNode): Map<string, Key> {
  const keys = new Map<string, Key>();
  const add = (properties: SchemaNode['properties'], required: SchemaNode['required'], place: string) => {
    for (const [name, node] of Object.entries(properties ?? {})) {
      const key = keys.get(name) ?? { node, places: [], requiredIn: [] };
      key.places.push(place);
      if (required?.includes(name)) key.requiredIn.push(place);
      keys.set(name, key);
    }
  };
  for (const form of schema.anyOf ?? [schema]) {
    const targets = form.properties?.targets?.additionalProperties;
    add(form.properties, form.required, targets === undefined ? oneTarget : shared);
    if (typeof targets === 'object') add(targets.properties, targets.required, inTarget);
  }
  return keys;
}

/** What a value is, in words. */
function typeWords(node: SchemaNode): string {
  if (node.enum !== undefined) return `one of ${node.enum.map((v) => `\`${String(v)}\``).join(', ')}`;
  if (node.anyOf !== undefined) return [...new Set(node.anyOf.map(typeWords))].join(', or ');
  switch (node.type) {
    case 'string':
      return 'text';
    case 'integer':
      return 'a whole number';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'true or false';
    case 'array':
      return node.items === undefined ? 'a list' : `a list of ${plainType(node.items)}`;
    case 'object':
      return node.properties === undefined ? 'pairs, `name: value`' : 'keys';
    default:
      return 'a value';
  }
}

/** A list item's type: a list of values, or of text. */
function plainType(node: SchemaNode): string {
  if (node.enum !== undefined) return `values: ${node.enum.map((v) => `\`${String(v)}\``).join(', ')}`;
  return node.type === 'string' ? 'text' : typeWords(node);
}

/** The entries an object holds, wherever it sits in the key (inside anyOf, a pair's value). */
function entries(node: SchemaNode): [string, SchemaNode, boolean][] {
  const found: [string, SchemaNode, boolean][] = [];
  const visit = (current: SchemaNode): void => {
    for (const [name, child] of Object.entries(current.properties ?? {})) {
      found.push([name, child, current.required?.includes(name) ?? false]);
    }
    for (const option of current.anyOf ?? []) visit(option);
    if (typeof current.additionalProperties === 'object') visit(current.additionalProperties);
  };
  for (const option of node.anyOf ?? []) visit(option);
  if (typeof node.additionalProperties === 'object') visit(node.additionalProperties);
  return found;
}

/** The first description a pair's value gives (the server folder of an upload entry). */
function valueDescription(node: SchemaNode): string | undefined {
  const value = typeof node.additionalProperties === 'object' ? node.additionalProperties : undefined;
  if (value === undefined) {
    for (const option of node.anyOf ?? []) {
      const found = valueDescription(option);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return value.description ?? value.anyOf?.find((option) => option.description)?.description;
}

/** A description as a sentence: a capital first, a full stop last. */
const sentenceOf = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${text.endsWith('.') ? '' : '.'}`;

const cell = (text: string): string => text.replaceAll('|', '\\|');

function section(name: string, key: Key, help: Map<string, string>): string[] {
  const { node } = key;
  const lines = [`### \`${name}\``, ''];
  const said = node.description ?? help.get(name);
  if (said !== undefined) lines.push(sentenceOf(said), '');
  lines.push(`- **Value:** ${typeWords(node)}`);
  if (node.minimum !== undefined && node.maximum !== undefined) {
    lines.push(`- **Range:** from ${node.minimum} to ${node.maximum}`);
  }
  const each = valueDescription(node);
  if (each !== undefined) lines.push(`- **Each value:** ${each}`);
  lines.push(`- **Where:** ${key.places.join('; ')}`);
  if (key.requiredIn.length > 0) lines.push(`- **Required:** ${key.requiredIn.join('; ')}`);
  const rows = entries(node).filter(
    ([child], index, all) => all.findIndex(([other]) => other === child) === index,
  );
  if (rows.length > 0) {
    lines.push('', 'An entry may also be written with these keys:', '');
    lines.push('| Key | Value | Meaning |', '|---|---|---|');
    for (const [child, childNode, required] of rows) {
      const meaning = `${childNode.description ?? ''}${required ? ' (required)' : ''}`.trim();
      lines.push(`| \`${child}\` | ${cell(typeWords(childNode))} | ${cell(meaning)} |`);
    }
  }
  lines.push('');
  return lines;
}

/** The config page in Markdown, from the schema of sealup.yml. */
export function configPage(schema: unknown): string {
  const keys = collectKeys(schema as SchemaNode);
  const help = helpWords();
  return [
    '---',
    'title: sealup.yml',
    'description: Every key of sealup.yml, built from its JSON schema.',
    '---',
    '',
    '<!-- Generated from schema.json by site/scripts/config-page.ts at each build. Do not edit. -->',
    '',
    'sealup reads `sealup.yml` (or `sealup.yaml`) from the folder it runs in, then from parent',
    'folders up to the repo root. `sealup help config` prints the same keys in short.',
    '',
    '## Two forms',
    '',
    'With **one target**, its keys sit at the top level of the file:',
    '',
    '```yaml',
    'server: sftp://deploy@ssh.example.com/home/site/www',
    'password: ${SEALUP_PASSWORD}',
    'hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sx…',
    'upload: dist',
    '```',
    '',
    'With **several targets**, each one has its keys under `targets:`, and what to send can stay',
    'at the top level for all of them:',
    '',
    '```yaml',
    'upload: dist',
    'targets:',
    '  staging:',
    '    server: sftp://deploy@ssh.example.com/home/site/staging',
    '    password: ${STAGING_PASSWORD}',
    '  production:',
    '    server: sftp://deploy@ssh.example.com/home/site/www',
    '    password: ${PRODUCTION_PASSWORD}',
    '```',
    '',
    '## Variables',
    '',
    '`${VAR}` reads a variable, `${VAR:?message}` stops with your message when it is not set, and',
    '`$$` writes a plain `$`. Variables come from the environment, and on your machine from',
    '`sealup.env` (or the file given to `--env-file`). A password is always a variable: sealup',
    'stops on a password written in the file.',
    '',
    '## Keys',
    '',
    ...[...keys].flatMap(([name, key]) => section(name, key, help)),
  ].join('\n');
}

if (import.meta.main) {
  const site = join(import.meta.dirname, '..');
  const schema: unknown = JSON.parse(readFileSync(join(site, '..', 'schema.json'), 'utf8'));
  writeFileSync(join(site, 'src', 'content', 'docs', 'config.md'), configPage(schema));
}
