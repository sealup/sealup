// The sink itself: how a Line becomes bytes on a stream. Each segment redacted, styled when
// colour is on, the Unicode fallbacks, the line redacted whole; in GitHub's form a line that
// could start a workflow command is paused; sealup's own workflow commands and annotations; the
// form of a word of a command to copy. Every file of report writes through these.

import { relative, sep } from 'node:path';
import { styleText } from 'node:util';
import { redact } from '../secret/index.ts';
import type { Annotation } from './annotations.ts';
import type { Line, Style } from './format.ts';
import { command } from './log.ts';

/** Where a reporter writes. */
export interface Out {
  readonly write: (text: string) => unknown;
  /** Colour on: the caller has checked the stream is a terminal and colour is not turned off. */
  readonly color: boolean;
  /** The stream is a terminal: the progress line is drawn (never in a log, decision 0024). */
  readonly terminal: boolean;
  /** The terminal shows ✓ ✗ ━ ─; when false, `√ ×` and a `#`/`-` bar instead. Default true. */
  readonly unicode?: boolean;
}

/**
 * The fallbacks where Unicode is unsafe (decision 0024 §3; the legacy Windows console), the
 * prompts' `›` and `•` included.
 */
const ascii: Readonly<Record<string, string>> = {
  '✓': '√',
  '✗': '×',
  '━': '#',
  '─': '-',
  '›': '>',
  '•': '*',
};

/** Back to the start of the line, and clear it: how the progress line is redrawn and removed. */
export const eraseLine = '\r\x1b[2K';
/** At most ten redraws a second (cli-output notes, 0024 §4). */
export const redrawMs = 100;

const styles: Readonly<Record<Style, Parameters<typeof styleText>[0]>> = {
  green: 'green',
  red: 'red',
  bold: 'bold',
  dim: 'dim',
  boldGreen: ['bold', 'green'],
  boldRed: ['bold', 'red'],
  yellow: 'yellow',
  inverseYellow: ['inverse', 'yellow'],
};

/** One line: each segment redacted, styled when colour is on, then the line redacted whole. */
export function render(out: Out, line: Line): string {
  const text = line
    .map((segment) => {
      if (typeof segment === 'string') return redact(segment);
      const plain = redact(segment.text);
      return out.color && plain !== ''
        ? styleText(styles[segment.style], plain, { validateStream: false })
        : plain;
    })
    .join('');
  const shown = out.unicode === false ? text.replace(/[✓✗━─›•]/g, (c) => ascii[c] ?? c) : text;
  return redact(shown);
}

export function writeLines(out: Out, lines: readonly Line[], form: Form = 'terminal'): void {
  for (const line of lines) {
    const text = render(out, line);
    out.write(form === 'github' && startsCommand(out, line) ? `${paused(text)}\n` : `${text}\n`);
  }
}

/**
 * Whether GitHub could read a line as a workflow command: it does after leading spaces, so an
 * indented line from a user value (a path cut over two lines) could start one (decision 31).
 * Judged on the words, colour codes left out.
 */
function startsCommand(out: Out, line: Line): boolean {
  return render({ ...out, color: false }, line)
    .trimStart()
    .startsWith('::');
}

/**
 * The line between GitHub's `::stop-commands::<token>` and `::<token>::`, so it shows as it is.
 * The token is fresh each time: no name can guess it to resume commands early.
 */
function paused(text: string): string {
  const token = crypto.randomUUID();
  return `${command('stop-commands', {}, token)}\n${text}\n::${token}::`;
}

/** One of sealup's own GitHub workflow commands, redacted like every other line. */
export function writeCommand(out: Out, text: string): void {
  out.write(`${redact(text)}\n`);
}

/**
 * Where human output goes (decision 0024 §1, §8, §9; cli chooses): `terminal` (stderr is a
 * terminal), `github` (GitHub Actions, stderr not a terminal), `log` (anything else).
 */
export type Form = 'terminal' | 'log' | 'github';

/** GitHub shows at most this many annotations of each level per step; the log has them all. */
const annotationsPerLevel = 10;

/** The workflow commands of these annotations: a file from the workspace, `/`-separated. */
export function annotationCommands(
  found: readonly Annotation[],
  workspace: string | undefined,
): string[] {
  const counts = new Map<string, number>();
  const commands: string[] = [];
  for (const annotation of found) {
    const count = counts.get(annotation.level) ?? 0;
    if (count === annotationsPerLevel) continue;
    counts.set(annotation.level, count + 1);
    const { file, line, title, message } = annotation;
    const shown =
      file === undefined || workspace === undefined
        ? file
        : relative(workspace, file).split(sep).join('/');
    commands.push(command(annotation.level, { file: shown, line, title }, message));
  }
  return commands;
}

/** A word of a command to copy: as is when plain, else in double quotes (POSIX and Windows). */
export function shellWord(word: string): string {
  return /^[\w./:@%+=,-]+$/.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`;
}
