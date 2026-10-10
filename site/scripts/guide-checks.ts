// The guide checks (spec sealup/sealup#41 story 93, ticket #65), run on the site's Markdown
// sources:
//   - every `sealup` command, in a code block or inline code, names a command `help` lists, with
//     flags that command's help screen offers, and a target only where it takes one;
//   - every `text` block of a guide is sealup's output, taken from a test of the CLI: the comment
//     `<!-- output: <test> -->` just above it names the test, and each line of the block is a line
//     that test expects (a golden), so no output is typed by hand.
// The home page keeps its commands and samples as data (src/home/samples.ts): `sampleProblems`
// checks them by the same rules (ticket #67).
//
// The CLI's own words are the source: the help screens come from src/report/help.ts (pure, so
// Node runs it as it is), the output lines from the test files under test/.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpLines, helpTopics } from '../../src/report/help.ts';

/** A help screen as plain text lines. */
function screen(topic?: (typeof helpTopics)[number]): string[] {
  const lines = topic === undefined ? helpLines() : helpLines(topic);
  return lines.map((line) =>
    line.map((segment) => (typeof segment === 'string' ? segment : segment.text)).join(''),
  );
}

/** A flag line of a help screen: `  -c, --config <file>     Use this…`. */
const flagLine = /^\s+(?:(-\w), )?(--[\w-]+)(?: <[\w-]+>)?(?=\s{2,}|$)/;

interface Flag {
  readonly names: readonly string[];
  readonly takesValue: boolean;
}

/** The flags a screen lists in its flag lines. */
function listedFlags(lines: readonly string[]): Flag[] {
  return lines.flatMap((line) => {
    const match = flagLine.exec(line);
    if (match === null) return [];
    const names = [match[1], match[2]].filter((name) => name !== undefined);
    return [{ names, takesValue: /<[\w-]+>/.test(match[0]) }];
  });
}

interface Command {
  readonly flags: readonly Flag[];
  /** What its one positional word is: a target, a help topic, or nothing. */
  readonly positional: 'target' | 'topic' | 'none';
}

interface Help {
  readonly global: readonly Flag[];
  readonly commands: ReadonlyMap<string, Command>;
}

let help: Help | undefined;

/** What `sealup --help` and each command's screen offer. */
function helpModel(): Help {
  if (help !== undefined) return help;
  const overview = screen();
  const global = listedFlags(overview);
  const always = global.filter((flag) => flag.names.some((name) => ['--help', '--debug'].includes(name)));
  const names = overview
    .slice(overview.indexOf('COMMANDS') + 1)
    .map((line) => /^ {2}([a-z-]+) {2,}/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && helpTopics.includes(name as never));
  const commands = new Map<string, Command>();
  for (const name of names) {
    const lines = screen(name as (typeof helpTopics)[number]);
    const usage = lines.find((line) => line.trim().startsWith(`sealup ${name}`)) ?? '';
    const globalLine = lines.find((line) => line.trim().startsWith('Global flags:')) ?? '';
    const named = new Set(globalLine.match(/-{1,2}[\w-]+/g) ?? []);
    const shared = global.filter((flag) => flag.names.some((n) => named.has(n)));
    commands.set(name, {
      flags: [...listedFlags(lines), ...shared, ...always],
      positional: usage.includes('[target]') ? 'target' : usage.includes('[topic]') ? 'topic' : 'none',
    });
  }
  help = { global, commands };
  return help;
}

/** What is wrong with one `sealup …` command line, or undefined when help offers it. */
function commandProblem(words: readonly string[]): string | undefined {
  const { global, commands } = helpModel();
  const [first, ...rest] = words;
  const command = first !== undefined && !first.startsWith('-') ? commands.get(first) : undefined;
  if (first !== undefined && !first.startsWith('-') && command === undefined) {
    return `no command ${first} (sealup help)`;
  }
  const flags = command?.flags ?? global;
  const where = command === undefined ? 'sealup --help' : `sealup help ${first}`;
  const args = command === undefined ? words : rest;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? '';
    if (!word.startsWith('-') || word === '-') {
      positionals.push(word);
      continue;
    }
    const [name = '', inline] = word.split('=', 2);
    const flag = flags.find((candidate) => candidate.names.includes(name));
    if (flag === undefined) {
      return command === undefined
        ? `sealup has no flag ${name} (${where})`
        : `${first} has no flag ${name} (${where})`;
    }
    if (flag.takesValue && inline === undefined) i++;
  }
  if (positionals.length === 0) return undefined;
  if (command === undefined || command.positional === 'none') {
    return `${first ?? 'sealup'} takes no target (${where})`;
  }
  if (positionals.length > 1) return `${first} takes one ${command.positional} (${where})`;
  const [word = ''] = positionals;
  const placeholder = /^<[\w-]+>$/.test(word);
  if (command.positional === 'topic' && !placeholder && !helpTopics.includes(word as never)) {
    return `no help topic ${word} (${where})`;
  }
  return undefined;
}

/** The words of a `sealup …` command as written on a page, or undefined for other text. */
function sealupWords(text: string): string[] | undefined {
  const command = text
    .replace(/^\$\s+/, '')
    .replace(/\s+#.*$/, '')
    .trim();
  // A synopsis's optional parts (`[target]`, `[flags]`) are left out; `<…>` stands for a value.
  const words = command.split(/\s+/).filter((word) => !/^\[.*\]$/.test(word));
  if (words[0] === 'npx') words.shift();
  const [head] = words;
  if (head === undefined || !/^sealup(@[\w.<>-]+)?$/.test(head)) return undefined;
  return words.slice(1);
}

/** A string literal of a test file: its text parts, between the values built in code. */
type Literal = readonly string[];

/** Where a regex literal can start: after an operator or an opening bracket, not after a value. */
const beforeRegex = /[(,=:[!&|?{};+\-*%<>~^]$/;

/**
 * The string literals of a TypeScript test file, comments left out: '…', "…" and `…`, each as
 * its text parts (a template's `${…}` splits it). Regex literals are skipped, so a quote in one
 * never starts a string.
 */
export function literals(source: string): Literal[] {
  const found: Literal[] = [];
  let i = 0;
  let code = '';
  const escaped = (): string => {
    const next = source[i + 1] ?? '';
    i += 2;
    if (next === 'n') return '\n';
    if (next === 't') return '\t';
    if (next === 'r') return '\r';
    if (next === 'u' || next === 'x') {
      const braced = next === 'u' && source[i] === '{';
      const hex = braced
        ? (/^\{([0-9a-fA-F]+)\}/.exec(source.slice(i))?.[1] ?? '')
        : source.slice(i, i + (next === 'u' ? 4 : 2));
      i += hex.length + (braced ? 2 : 0);
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    // A line continuation, or any other escaped character as it is.
    return next === '\r' || next === '\n' ? '' : next;
  };
  /** A quoted string from i (at its quote), to just after its closing quote. */
  const quoted = (): string => {
    const quote = source[i] ?? '';
    i++;
    let text = '';
    while (i < source.length && source[i] !== quote) {
      text += source[i] === '\\' ? escaped() : source[i++];
    }
    i++;
    return text;
  };
  /** A template from i (at its backtick): its text parts, the `${…}` expressions skipped. */
  const template = (): string[] => {
    i++;
    const parts = [''];
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        parts[parts.length - 1] += escaped();
      } else if (source[i] === '$' && source[i + 1] === '{') {
        i += 2;
        skipExpression();
        parts.push('');
      } else {
        parts[parts.length - 1] += source[i++];
      }
    }
    i++;
    return parts;
  };
  /** Skips a `${…}` expression up to its closing brace, strings and templates inside it too. */
  const skipExpression = (): void => {
    let depth = 1;
    while (i < source.length && depth > 0) {
      const char = source[i] ?? '';
      if (char === "'" || char === '"') quoted();
      else if (char === '`') template();
      else {
        if (char === '{') depth++;
        if (char === '}') depth--;
        i++;
      }
    }
  };
  while (i < source.length) {
    const char = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (char === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (char === '/' && (code.trim() === '' || beforeRegex.test(code.trimEnd()))) {
      i++;
      let inClass = false;
      while (i < source.length && (source[i] !== '/' || inClass) && source[i] !== '\n') {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i++;
      }
      i++;
      code += 'regex';
    } else if (char === "'" || char === '"') {
      found.push([quoted()]);
      code += 'string';
    } else if (char === '`') {
      found.push(template());
      code += 'string';
    } else {
      code += char;
      i++;
    }
    if (code.length > 200) code = code.slice(-100);
  }
  return found;
}

/** The colour tokens of a golden line (src/testkit/golden.ts), which print no text. */
const colourTokens = /\{(gb|rb|yb|inv|g|y|r|b|d|\/)\}/g;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every line a test file expects, as a pattern: each line of each string literal, colour tokens
 * taken out, a value built in code standing for any text. A line with no text of its own (only
 * built values, or blank) is left out: it would match anything.
 */
export function expectedLines(source: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const literal of literals(source)) {
    const lines: string[][] = [[]];
    literal.forEach((part, index) => {
      if (index > 0) lines[lines.length - 1]?.push('\u0000');
      const [first = '', ...rest] = part.replace(colourTokens, '').split('\n');
      lines[lines.length - 1]?.push(first);
      for (const line of rest) lines.push([line]);
    });
    for (const pieces of lines) {
      const text = pieces.join('');
      if (text.replace(/\u0000/g, '').trim() === '') continue;
      const pattern = text.trimEnd().split('\u0000').map(escapeRegex).join('.*');
      patterns.push(new RegExp(`^${pattern}$`, 'u'));
    }
  }
  return patterns;
}

/** Where the files of the repo's test/ folder are (this file lives in `site/scripts/`). */
const testFolder = join(import.meta.dirname, '..', '..', 'test');

/** Reads a test file by its path under test/, `/`-separated; undefined when there is none. */
function readTestFile(path: string): string | undefined {
  const file = join(testFolder, ...path.split('/'));
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** A test named in an output comment: a golden's name, or a path under test/ (a `.ts` file). */
const testPath = (name: string): string =>
  name.includes('/') || name.endsWith('.ts') ? name : `integration/goldens/${name}.test.ts`;

interface Sources {
  /** A test file's text by its path under test/, `/`-separated. */
  readonly readTest: (path: string) => string | undefined;
}

/**
 * The problems of one page (its path under the docs folder): `<page>:<line> <what>`, in line
 * order. Error pages (`e/…`) show their messages with example values: their text blocks need
 * no test.
 */
export function pageProblems(
  page: string,
  markdown: string,
  sources: Sources = { readTest: readTestFile },
): string[] {
  const problems: string[] = [];
  const outputsNeeded = !page.startsWith('e/');
  const patterns = new Map<string, RegExp[] | undefined>();
  const expected = (name: string): RegExp[] | undefined => {
    if (!patterns.has(name)) {
      const source = sources.readTest(testPath(name));
      patterns.set(name, source === undefined ? undefined : expectedLines(source));
    }
    return patterns.get(name);
  };
  let output: { readonly name: string; readonly line: number } | undefined;
  let outputBlock: { readonly name: string; readonly lines: RegExp[] | undefined } | undefined;
  const check = (text: string, line: number): void => {
    const words = sealupWords(text);
    if (words === undefined) return;
    const problem = commandProblem(words);
    const shown = ['sealup', ...words].join(' ');
    if (problem !== undefined) problems.push(`${page}:${line} \`${shown}\`: ${problem}`);
  };
  const lines = markdown.split(/\r?\n/);
  let fence: { readonly marker: string; readonly lang: string } | undefined;
  lines.forEach((text, index) => {
    const line = index + 1;
    const opening = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(text);
    if (fence === undefined && opening !== null) {
      fence = { marker: opening[1] ?? '```', lang: opening[2] ?? '' };
      outputBlock = undefined;
      if (output !== undefined && output.line === line - 1) {
        const lines = expected(output.name);
        if (lines === undefined) {
          problems.push(`${page}:${line - 1} no test ${output.name} (test/${testPath(output.name)})`);
        }
        outputBlock = { name: output.name, lines };
      } else if (fence.lang === 'text' && outputsNeeded) {
        problems.push(`${page}:${line} a text block of sealup output needs <!-- output: <test> --> above it`);
      }
      output = undefined;
      return;
    }
    if (fence !== undefined) {
      if (text.trim().startsWith(fence.marker)) {
        fence = undefined;
        outputBlock = undefined;
        return;
      }
      if (['sh', 'bash', 'shell', 'console'].includes(fence.lang) || /^\s*\$ /.test(text)) {
        check(text, line);
        return;
      }
      if (outputBlock?.lines !== undefined && text.trim() !== '') {
        const shown = text.trimEnd();
        if (!outputBlock.lines.some((pattern) => pattern.test(shown))) {
          problems.push(`${page}:${line} not a line of ${outputBlock.name}: ${JSON.stringify(shown)}`);
        }
      }
      return;
    }
    const marker = /^\s*(?:<!--|\{\/\*)\s*output:\s*(\S+)\s*(?:-->|\*\/\})\s*$/.exec(text);
    if (marker !== null) {
      output = { name: marker[1] ?? '', line };
      return;
    }
    for (const span of text.matchAll(/`([^`]+)`/g)) check(span[1] ?? '', line);
  });
  return problems;
}

/** Lines of sealup's output shown outside Markdown (the home page), and the tests they come from. */
export interface Sample {
  /** Goldens' names or paths under test/: each line is a line one of them expects. */
  readonly tests: readonly string[];
  /** The lines as the goldens write them, colour tokens included. */
  readonly lines: readonly string[];
}

export interface Samples {
  /** Every command the page shows, as typed: `sealup …` or `npx sealup …`. */
  readonly commands: readonly string[];
  readonly samples: Readonly<Record<string, Sample>>;
}

/**
 * The problems of a page's samples given as data rather than Markdown (the home page): each
 * command must be one `help` offers, each non-blank line a line one of its tests expects.
 */
export function sampleProblems(page: Samples, sources: Sources = { readTest: readTestFile }): string[] {
  const problems: string[] = [];
  for (const command of page.commands) {
    const words = sealupWords(command);
    const problem = words === undefined ? 'not a sealup command' : commandProblem(words);
    if (problem !== undefined) problems.push(`command \`${command}\`: ${problem}`);
  }
  for (const [name, sample] of Object.entries(page.samples)) {
    const patterns: RegExp[] = [];
    for (const test of sample.tests) {
      const source = sources.readTest(testPath(test));
      if (source === undefined) problems.push(`${name}: no test ${test} (test/${testPath(test)})`);
      else patterns.push(...expectedLines(source));
    }
    for (const line of sample.lines) {
      const shown = line.replace(colourTokens, '').trimEnd();
      if (shown.trim() === '' || patterns.some((pattern) => pattern.test(shown))) continue;
      problems.push(`${name}: not a line of ${sample.tests.join(' or ')}: ${JSON.stringify(shown)}`);
    }
  }
  return problems;
}
