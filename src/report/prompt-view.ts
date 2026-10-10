// The terminal's questions as cli asks them: the view that draws and redraws them in place
// (prompt.ts lays out their lines).

import type { Line } from './format.ts';
import {
  hiddenLine,
  optionLines,
  type PickerOption,
  pickedLine,
  textLine,
  yesNoLine,
} from './prompt.ts';
import { eraseLine, type Out, render, writeLines } from './sink.ts';

/** The cursor hidden while a picker is drawn, and shown again once it is answered. */
const hideCursor = '\x1b[?25l';
const showCursor = '\x1b[?25h';

/**
 * Draws the terminal's questions on stderr (spec #24 decisions 15-16), cli asking and reading
 * the keys. A picker is drawn under its question and redrawn in place (cursor up, erase down),
 * the cursor hidden; a yes/no or hidden question is one line redrawn as it is typed, the cursor
 * at its end. Every line passes through redaction like any other.
 */
export interface PromptView {
  /** The picker with `›` on `selected`; the first call draws the question too. */
  picker(question: string, options: readonly PickerOption[], selected: number): void;
  /** The picker answered: `✓ <label>` and a blank line where the options were. */
  picked(question: string, label: string): void;
  /** A yes/no question, its default in capitals, and what is typed so far. */
  yesNo(question: string, defaultYes: boolean, typed: string): void;
  /** A hidden question with one `•` per character typed (`count`). */
  hidden(question: string, count: number): void;
  /** A question whose answer shows as typed. */
  text(question: string, typed: string): void;
  /** A yes/no or hidden question answered: its line ends. */
  answered(): void;
  /** No answer (Esc, Ctrl-C): a picker's options are erased, a question's line ends. */
  cancelled(): void;
}

export function createPromptView(out: Out): PromptView {
  /** Option lines drawn under the picker's question; the cursor is on the line after them. */
  let rows = 0;
  let picking = false;
  const erase = (): void => {
    if (rows > 0) out.write(`\x1b[${rows}A\x1b[J`);
    rows = 0;
  };
  const line = (shown: Line): void => {
    out.write(`${eraseLine}${render(out, shown)}`);
  };
  return {
    picker(question, options, selected) {
      if (!picking) {
        out.write(hideCursor);
        writeLines(out, [[question]]);
        picking = true;
      }
      erase();
      const lines = optionLines(question, options, selected);
      writeLines(out, lines);
      rows = lines.length;
    },
    picked(question, label) {
      erase();
      writeLines(out, [pickedLine(question, label), []]);
      out.write(showCursor);
      picking = false;
    },
    yesNo: (question, defaultYes, typed) => line(yesNoLine(question, defaultYes, typed)),
    hidden: (question, count) => line(hiddenLine(question, count)),
    text: (question, typed) => line(textLine(question, typed)),
    answered: () => out.write('\n'),
    cancelled() {
      if (!picking) {
        out.write('\n');
        return;
      }
      erase();
      out.write(showCursor);
      picking = false;
    },
  };
}
