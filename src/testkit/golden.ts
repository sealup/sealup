// Goldens in the CLI page's own colour markup (docs/exploration/assets/06/sealup-cli.html, the
// `{g}…{/}` tokens; notes: goldens.md "How the page encodes colour"). A golden test writes the
// scenario's lines with the page's markup and the fixture's names and numbers; goldenText gives
// the exact bytes a reporter must write, styled as the page's ANSI map says, or plain.
//
// Markup: `{g}` green, `{y}` yellow, `{r}` red, `{b}` bold, `{d}` dim, `{gb}` bold green, `{rb}`
// bold red, `{yb}` bold yellow, `{inv}` inverse yellow; `{/}` back to plain. No nesting: a new
// token replaces the open one (as on the page).

import { styleText } from 'node:util';

type Format = Parameters<typeof styleText>[0];

const formats: Readonly<Record<string, Format>> = {
  g: 'green',
  y: 'yellow',
  r: 'red',
  b: 'bold',
  d: 'dim',
  gb: ['bold', 'green'],
  rb: ['bold', 'red'],
  yb: ['bold', 'yellow'],
  inv: ['inverse', 'yellow'],
};

const token = /\{(gb|rb|yb|inv|g|y|r|b|d|\/)\}/g;

/** The lines of a golden as written to a stream: each line ends with `\n`. */
export function goldenText(lines: readonly string[], options: { readonly color: boolean }): string {
  return lines.map((line) => `${render(line, options.color)}\n`).join('');
}

/** A control sequence (ESC `[` …), a line break, a carriage return, or a run of text. */
const esc = String.fromCharCode(27);
const piece = new RegExp(`${esc}\\[([?\\d;]*)([A-Za-z])|\\r|\\n|[^${esc}\\r\\n]+`, 'g');

/**
 * What a terminal shows once `raw` is written, as the CLI page shows it (goldens.md, "Progress
 * line"): an erased line is gone, so a progress line replaced by the next line leaves nothing.
 * It models what report writes: CR, ESC[2K (erase the line), ESC[nA (cursor up), ESC[J (erase to
 * the end of the screen), ESC[?25l/h (cursor hidden, shown: not on the screen) and colour codes
 * (kept as they are, as goldenText writes them). Text is written at the end of its line or on a
 * cleared one; anything else (text over a line not cleared, another sequence) throws, so a test
 * never reads a screen this model gets wrong.
 */
export function screenOf(raw: string): string {
  const lines = [''];
  let row = 0;
  /** The cursor is at the start of its line (after CR, a line break, or going up). */
  let atStart = true;
  const refuse = (what: string): never => {
    throw new Error(`screenOf does not model ${JSON.stringify(what)}`);
  };
  const write = (text: string): void => {
    if (atStart && lines[row] !== '') {
      throw new Error(`screenOf: ${JSON.stringify(text)} written over a line not cleared`);
    }
    lines[row] += text;
    atStart = false;
  };
  for (const match of raw.matchAll(piece)) {
    const [text, param = '', final] = match;
    if (text === '\n') {
      row += 1;
      if (row === lines.length) lines.push('');
      atStart = true;
    } else if (text === '\r') {
      atStart = true;
    } else if (final === undefined) {
      write(text);
    } else if (final === 'm') {
      write(text);
    } else if (final === 'K' && param === '2') {
      lines[row] = '';
    } else if (final === 'A' && atStart) {
      row = Math.max(0, row - (param === '' ? 1 : Number(param)));
    } else if (final === 'J' && (param === '' || param === '0') && atStart) {
      lines[row] = '';
      lines.length = row + 1;
    } else if ((final === 'l' || final === 'h') && param === '?25') {
      // The cursor hidden or shown: nothing on the screen.
    } else {
      refuse(text);
    }
  }
  return lines.join('\n');
}

function render(line: string, color: boolean): string {
  let out = '';
  let style: Format | undefined;
  let last = 0;
  const flush = (text: string): void => {
    if (text === '') return;
    out += color && style !== undefined ? styleText(style, text, { validateStream: false }) : text;
  };
  for (const match of line.matchAll(token)) {
    flush(line.slice(last, match.index));
    const name = match[1] ?? '/';
    style = name === '/' ? undefined : formats[name];
    last = match.index + match[0].length;
  }
  flush(line.slice(last));
  return out;
}
