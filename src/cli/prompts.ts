// The terminal's questions (spec #24 decisions 15-16, exploration 06 §4.1): the target picker, a
// yes/no question, a hidden answer and a visible one (init's server address). cli asks only when
// stdin and stderr are both terminals; this file reads the keys in raw mode and report draws
// (PromptView). Esc or Ctrl-C (a key in raw mode, not a signal), the end of input, or the run's
// AbortSignal (SIGTERM) gives no answer: the caller stops with exit 130, nothing done.

import type { ResolvedConfig } from '../config/index.ts';
import type { PickerOption, PromptView } from '../report/index.ts';

/** The terminal's keyboard (stdin); bin.ts wires the process's, tests type their own keys. */
export interface Keyboard {
  /** Raw mode on: each key as typed, no echo, no line editing, Ctrl-C as a key (`\u0003`). */
  open(): void;
  /** The next chunk typed (one key, or several when pasted); undefined at the end of input. */
  read(): Promise<string | undefined>;
  /** Raw mode off; a read still waiting gets undefined. */
  close(): void;
}

/** Questions on the terminal; each gives undefined when there is no answer (Esc, Ctrl-C). */
export interface Prompts {
  /** The picker: ↑/↓ move `›`, Enter picks; the index of the option picked. */
  pick(question: string, options: readonly PickerOption[]): Promise<number | undefined>;
  /** Yes or no: `y`, `yes`, `n`, `no` in any case, then Enter; Enter alone takes the default. */
  yesNo(question: string, defaultYes: boolean): Promise<boolean | undefined>;
  /** A hidden answer (a password): one `•` per character on the screen; what was typed. */
  hidden(question: string): Promise<string | undefined>;
  /** A visible answer (a server address), shown as typed; what was typed. */
  text(question: string): Promise<string | undefined>;
}

type Key =
  | { readonly name: 'up' | 'down' | 'enter' | 'stop' | 'backspace' | 'other' }
  | { readonly name: 'char'; readonly char: string };

const key = (name: 'up' | 'down' | 'enter' | 'stop' | 'backspace' | 'other'): Key => ({ name });

/**
 * The keys in a chunk, as a terminal in raw mode sends them: ESC `[` or ESC `O` sequences (the
 * arrows, others ignored), a lone ESC (Esc), CR or LF or CR LF (Enter), DEL or BS (Backspace),
 * Ctrl-C; any other control character types nothing. A character beyond the basic plane stays
 * whole.
 */
function keysOf(chunk: string): Key[] {
  const keys: Key[] = [];
  let at = 0;
  while (at < chunk.length) {
    const char = String.fromCodePoint(chunk.codePointAt(at) ?? 0);
    const next = chunk[at + 1];
    if (char === '\u001b' && next === '[') {
      // Parameters, then one final byte from @ to ~.
      let end = at + 2;
      while (end < chunk.length && !/[@-~]/.test(chunk[end] ?? '')) end += 1;
      const final = chunk[end];
      const plain = end === at + 2;
      keys.push(
        plain && final === 'A' ? key('up') : plain && final === 'B' ? key('down') : key('other'),
      );
      at = end + 1;
    } else if (char === '\u001b' && next === 'O') {
      const final = chunk[at + 2];
      keys.push(final === 'A' ? key('up') : final === 'B' ? key('down') : key('other'));
      at += 3;
    } else if (char === '\u001b' || char === '\u0003') {
      keys.push(key('stop'));
      at += 1;
    } else if (char === '\r' || char === '\n') {
      keys.push(key('enter'));
      at += char === '\r' && next === '\n' ? 2 : 1;
    } else if (char === '\u007f' || char === '\b') {
      keys.push(key('backspace'));
      at += 1;
    } else {
      keys.push(/\p{Cc}/u.test(char) ? key('other') : { name: 'char', char });
      at += char.length;
    }
  }
  return keys;
}

export function createPrompts(
  keyboard: Keyboard,
  view: PromptView,
  signal: AbortSignal | undefined,
): Prompts {
  /** Keys read but not used yet: typed ahead, they go to the next question. */
  const pending: Key[] = [];

  /** The next key; undefined at the end of input, or once the run is interrupted. */
  async function nextKey(): Promise<Key | undefined> {
    while (pending.length === 0) {
      const chunk = await untilAborted(() => keyboard.read(), signal);
      if (chunk === undefined) return undefined;
      pending.push(...keysOf(chunk));
    }
    return pending.shift();
  }

  /** Raw mode for one question; a question left by an error is cleared from the screen. */
  async function asking<T>(ask: () => Promise<T>): Promise<T> {
    keyboard.open();
    try {
      return await ask();
    } catch (error) {
      view.cancelled();
      throw error;
    } finally {
      keyboard.close();
    }
  }

  return {
    pick(question, options) {
      let selected = 0;
      view.picker(question, options, selected);
      return asking(async () => {
        for (;;) {
          const pressed = await nextKey();
          if (pressed === undefined || pressed.name === 'stop') {
            view.cancelled();
            return undefined;
          }
          const chosen = options[selected];
          if (pressed.name === 'enter' && chosen !== undefined) {
            view.picked(question, chosen.label);
            return selected;
          }
          const moved =
            pressed.name === 'up'
              ? Math.max(0, selected - 1)
              : pressed.name === 'down'
                ? Math.min(options.length - 1, selected + 1)
                : selected;
          if (moved !== selected) {
            selected = moved;
            view.picker(question, options, selected);
          }
        }
      });
    },

    yesNo(question, defaultYes) {
      let typed = '';
      view.yesNo(question, defaultYes, typed);
      return asking(async () => {
        for (;;) {
          const pressed = await nextKey();
          if (pressed === undefined || pressed.name === 'stop') {
            view.cancelled();
            return undefined;
          }
          if (pressed.name === 'enter') {
            const answer = typed === '' ? defaultYes : yesOrNo(typed);
            typed = answer === undefined ? '' : answer ? 'y' : 'n';
            view.yesNo(question, defaultYes, typed);
            if (answer === undefined) continue;
            view.answered();
            return answer;
          }
          if (pressed.name === 'backspace') typed = withoutLast(typed);
          else if (pressed.name === 'char') typed += pressed.char;
          else continue;
          view.yesNo(question, defaultYes, typed);
        }
      });
    },

    hidden(question) {
      return typedAnswer((typed) => view.hidden(question, typed.length));
    },

    text(question) {
      return typedAnswer((typed) => view.text(question, typed.join('')));
    },
  };

  /** An answer typed, then Enter: `show` draws the line after each key. */
  function typedAnswer(show: (typed: readonly string[]) => void): Promise<string | undefined> {
    const typed: string[] = [];
    show(typed);
    return asking(async () => {
      for (;;) {
        const pressed = await nextKey();
        if (pressed === undefined || pressed.name === 'stop') {
          view.cancelled();
          return undefined;
        }
        if (pressed.name === 'enter') {
          view.answered();
          return typed.join('');
        }
        if (pressed.name === 'backspace') typed.pop();
        else if (pressed.name === 'char') typed.push(pressed.char);
        else continue;
        show(typed);
      }
    });
  }
}

/**
 * The target picker (S12, spec #24 decision 15): every target of the file in its order, each
 * with its server URL as written; the name picked, or undefined after Esc or Ctrl-C.
 */
export async function askTarget(
  prompts: Prompts,
  question: string,
  config: ResolvedConfig,
): Promise<string | undefined> {
  const names = [...config.targets.keys()];
  const options = names.map((name): PickerOption => {
    const server = config.targets.get(name)?.server;
    return server === undefined ? { label: name } : { label: name, hint: server };
  });
  const index = await prompts.pick(question, options);
  return index === undefined ? undefined : names[index];
}

function yesOrNo(typed: string): boolean | undefined {
  const answer = typed.toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return undefined;
}

/** The text without its last character (a character beyond the basic plane whole). */
function withoutLast(text: string): string {
  return [...text].slice(0, -1).join('');
}

/**
 * What `next` reads, or undefined once the signal aborts, whichever comes first; nothing is read
 * when it has already aborted. A read that loses the race ends with the keyboard's close.
 */
async function untilAborted(
  next: () => Promise<string | undefined>,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (signal === undefined) return next();
  if (signal.aborted) return undefined;
  const read = next();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([read, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
