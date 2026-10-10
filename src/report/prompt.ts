// The terminal's questions as lines (spec #24 decisions 15-16; the CLI page's picker and prompts,
// its `runPicker` and `runPrompt`): the target picker, a yes/no question, a hidden answer, a
// visible one. Pure (import rules, pure file): no node: import. index.ts draws them and redraws
// them in place.

import { type Line, style } from './format.ts';

/** One option of a picker: what is picked, and what tells it apart (a target's server URL). */
export interface PickerOption {
  readonly label: string;
  readonly hint?: string;
}

/** After the result of a run whose target was picked: the command that names it (S12). */
export function skipQuestionLine(command: string): Line {
  return ['    ', style(`Next time, skip the question: ${command}`, 'dim')];
}

/** A question's leading spaces: its options go two further in (the page's picker). */
function indentOf(question: string): string {
  return /^ */.exec(question)?.[0] ?? '';
}

/**
 * The picker's options under its question: `›` and the label in bold on the selected one, each
 * hint dim, three spaces after the longest label (S12).
 */
export function optionLines(
  question: string,
  options: readonly PickerOption[],
  selected: number,
): Line[] {
  const indent = indentOf(question);
  const width = Math.max(0, ...options.map((option) => option.label.length));
  return options.map((option, index): Line => {
    const hint =
      option.hint === undefined
        ? []
        : [' '.repeat(width - option.label.length + 3), style(option.hint, 'dim')];
    return index === selected
      ? [style(`${indent}  › `, 'boldGreen'), style(option.label, 'bold'), ...hint]
      : [`${indent}    ${option.label}`, ...hint];
  });
}

/** The picker once answered: `✓` and the label, where the options were. */
export function pickedLine(question: string, label: string): Line {
  return [`${indentOf(question)}  `, style('✓', 'green'), ` ${label}`];
}

/** The space between a question and its answer: none when the question ends with one. */
function gap(question: string): string {
  return /\s$/.test(question) ? '' : ' ';
}

/** A yes/no question, its default in capitals (`[y/N]`), then what is typed so far. */
export function yesNoLine(question: string, defaultYes: boolean, typed: string): Line {
  return [`${question}${gap(question)}${defaultYes ? '[Y/n]' : '[y/N]'} ${typed}`];
}

/** A hidden question: one `•` per character typed, never the characters themselves. */
export function hiddenLine(question: string, count: number): Line {
  return [`${question}${gap(question)}${'•'.repeat(count)}`];
}

/** A question whose answer shows as typed (a server address). */
export function textLine(question: string, typed: string): Line {
  return [`${question}${gap(question)}${typed}`];
}
