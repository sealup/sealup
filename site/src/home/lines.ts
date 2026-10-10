// How the home page draws sealup's output (decision 0037): golden lines with their colour tokens
// (src/testkit/golden.ts), and the job summary's Markdown rows. Pure, so the site's tests run it.

/** The colour tokens of a golden line: bold green, bold red, bold yellow, inverse, and so on. */
export type Style = 'gb' | 'rb' | 'yb' | 'inv' | 'g' | 'y' | 'r' | 'b' | 'd';

export interface Segment {
  readonly text: string;
  readonly style?: Style;
  /** A host key fingerprint: whole on a wide screen, cut short with an ellipsis on a phone. */
  readonly short?: true;
}

const token = /\{(gb|rb|yb|inv|g|y|r|b|d|\/)\}/g;
const fingerprint = /(SHA256:[A-Za-z0-9+/=]+)/;

/** A golden line as styled segments, each fingerprint a segment of its own. */
export function segments(line: string): Segment[] {
  const out: Segment[] = [];
  let style: Style | undefined;
  let at = 0;
  const push = (text: string): void => {
    for (const [index, part] of text.split(fingerprint).entries()) {
      if (part === '') continue;
      out.push({
        text: part,
        ...(style === undefined ? {} : { style }),
        ...(index % 2 === 1 ? { short: true as const } : {}),
      });
    }
  };
  for (const match of line.matchAll(token)) {
    push(line.slice(at, match.index));
    const name = match[1];
    style = name === '/' ? undefined : (name as Style);
    at = match.index + match[0].length;
  }
  push(line.slice(at));
  return out;
}

/** A golden line as plain text, as a screen reader or a printout gets it. */
export function plain(line: string): string {
  return line.replace(token, '');
}

/**
 * A line that ends with a size in its own column (sealup puts sizes at column 72): the text
 * before the gap, and the size. Undefined for any other line.
 */
export function columns(line: string): { readonly left: string; readonly right: string } | undefined {
  const match = /^(.*\S) {2,}(\d[\d.,]* [kKMG]?B)$/.exec(line);
  if (match === null) return undefined;
  return { left: match[1] ?? '', right: match[2] ?? '' };
}

/** The cells of a Markdown table row, trimmed: `| Deleted | 9 | |` → Deleted, 9 and empty. */
export function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** A Markdown cell's text and code spans, in order. */
export function inline(text: string): { readonly text: string; readonly code: boolean }[] {
  return text
    .split(/`([^`]*)`/)
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((part) => part.text !== '');
}
