// Where a value is in sealup.yml: its key path, and the 1-based line of that key in the parsed
// YAML document (or of its nearest parent key that exists). Also the shape tests of what the
// parser's toJS gives (a mapping, a record) and the order issues are reported in (by line).

import type { Document, LineCounter } from 'yaml';
import type { ConfigIssue } from '../contracts/index.ts';

/** A key path in the file: keys, and indexes in lists. */
export type Path = readonly (string | number)[];

/** The 1-based line of the key at `path`, or of its nearest parent key that exists. */
export function lineOf(doc: Document, lines: LineCounter, path: Path): number | undefined {
  for (let end = path.length; end > 0; end--) {
    const parent = end === 1 ? doc.contents : doc.getIn(path.slice(0, end - 1), true);
    const key = path[end - 1];
    const start = isMap(parent)
      ? rangeStart(parent.items.find((item) => keyValue(item.key) === key)?.key)
      : isSeq(parent) && typeof key === 'number'
        ? rangeStart(parent.items[key])
        : undefined;
    if (start !== undefined) return lines.linePos(start).line;
  }
  return isRecord(doc.contents) ? lineOfNode(doc.contents, lines) : undefined;
}

function lineOfNode(node: unknown, lines: LineCounter): number | undefined {
  const start = rangeStart(node);
  return start === undefined ? undefined : lines.linePos(start).line;
}

interface MapLike {
  readonly items: readonly { readonly key: unknown }[];
}

function isMap(node: unknown): node is MapLike {
  return (
    isRecord(node) &&
    Array.isArray(node.items) &&
    node.items.every((item: unknown) => isRecord(item) && 'key' in item)
  );
}

function isSeq(node: unknown): node is { readonly items: readonly unknown[] } {
  return isRecord(node) && Array.isArray(node.items) && !isMap(node);
}

function keyValue(key: unknown): unknown {
  return isRecord(key) && 'value' in key ? key.value : key;
}

function rangeStart(node: unknown): number | undefined {
  if (!isRecord(node) || !Array.isArray(node.range)) return undefined;
  const start: unknown = node.range[0];
  return typeof start === 'number' ? start : undefined;
}

export function isRecord(value: unknown): value is Record<string | number, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A YAML mapping, as toJS gives it: a plain object, not a list. */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

export function lineField(line: number | undefined): { line?: number } {
  return line === undefined ? {} : { line };
}

export function sorted(issues: readonly ConfigIssue[]): ConfigIssue[] {
  return [...issues].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
