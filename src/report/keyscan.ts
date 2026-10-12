// The words of `sealup keyscan` (S04, spec #24 decision 18): the target block with the key's
// state, then by state: the comparison to make before a yes, the line to paste, the key saved,
// or S17's two fingerprints when the server shows another key than the saved one. A hostKey read
// from a variable asks nothing: the line and the variable to set (plan 06 spec #88 decision 8).
// Pure (import rules, pure file): no node: import.

import type { ConfigPlace, KeyscanReport, Problem, ServerUrl } from '../contracts/index.ts';
import {
  fileName,
  hostKeyLabel,
  keyType,
  type Line,
  lineWord,
  noHostKey,
  style,
  targetLine,
} from './format.ts';
import type { Explained } from './problems.ts';
import { keyInVariable, setVariableLines } from './variable-words.ts';

/** One step of a keyscan's output, in the order cli prints them. */
export type KeyscanStep =
  /** Before the scan: the target block's first line. */
  | { readonly kind: 'target'; readonly name: string; readonly server: ServerUrl }
  /** The scan failed: the key line says so; the problem follows. */
  | { readonly kind: 'not-checked' }
  /**
   * Plain FTP: no host key, so nothing is scanned (spec #41 decision 12). `place`: the server
   * key's, which the fix names.
   */
  | { readonly kind: 'no-key'; readonly configFile: string; readonly place: ConfigPlace }
  /** A blank line: after a no, before the problem it leads to. */
  | { readonly kind: 'gap' }
  /**
   * The key shown: its line, then what comes before the question (`asking`), or without a
   * terminal, the line to paste (`where`: GitHub's words, or a plain log's). `again`: the words
   * after `sealup keyscan` to run it again for this target, as typed.
   */
  | {
      readonly kind: 'found';
      readonly report: KeyscanReport;
      readonly asking: boolean;
      readonly where: 'github' | 'log';
      readonly again: readonly string[];
      /**
       * The variable `hostKey` reads (`${NAME}`): nothing is asked or saved, and a key not saved
       * is shown with the variable to set (plan 06 spec #88 decision 8).
       */
      readonly variable?: string;
    }
  /** The key now in the file, on `line`. */
  | { readonly kind: 'saved'; readonly report: KeyscanReport; readonly line: number }
  /**
   * Not saved: the answer was no, or sealup could not edit the file where the target is written
   * (`{ … }` on one line). The line to paste follows.
   */
  | {
      readonly kind: 'kept';
      readonly report: KeyscanReport;
      readonly reason: 'answered-no' | 'cannot-edit';
      readonly again: readonly string[];
    };

/**
 * The lines of one step. `quote` makes a word of a command safe to copy (index.ts's shellWord).
 */
export function keyscanLines(step: KeyscanStep, quote: (word: string) => string): Line[] {
  const command = (again: readonly string[]): string =>
    ['sealup', 'keyscan', ...again].map(quote).join(' ');
  switch (step.kind) {
    case 'target':
      return [targetLine(step.name, step.server)];
    case 'not-checked':
      return [[hostKeyLabel, style('not checked', 'dim')], []];
    case 'no-key':
      return [
        [hostKeyLabel, style(noHostKey, 'dim')],
        [],
        ['  Plain FTP has no key to trust: there is nothing to save.'],
        [
          `    Most hosts also offer SFTP: write sftp:// in server (${fileName(step.configFile)}${lineWord(step.place)}).`,
        ],
      ];
    case 'gap':
      return [[]];
    case 'found':
      return step.variable === undefined
        ? foundLines(step.report, step.asking, step.where, command(step.again))
        : inVariableLines(step.report, step.variable);
    case 'saved': {
      const file = fileName(step.report.configFile);
      return [
        [],
        [
          '  ',
          style(step.report.state === 'other' ? '✓ Replaced.' : '✓ Saved.', 'boldGreen'),
          ` ${file} now holds this key (hostKey, line ${step.line}).`,
        ],
        ['    From now on sealup checks it before it sends your password. If the'],
        ['    server ever shows another key, sealup stops and changes nothing.'],
      ];
    }
    case 'kept': {
      const file = fileName(step.report.configFile);
      const first =
        step.reason === 'answered-no'
          ? [
              '  Nothing was saved. To trust this key later, paste this line into',
              `  ${file} yourself (or run ${command(step.again)} again):`,
            ]
          : [
              `  Nothing was saved: ${file} writes this target on one line ({ … }),`,
              '  where sealup cannot add a line. Paste this line into it yourself:',
            ];
      return [[], ...first.map((text): Line => [text]), [], pasteLine(step.report)];
    }
  }
}

/** The key's line of the target block, the blank line, then what its state calls for. */
function foundLines(
  report: KeyscanReport,
  asking: boolean,
  where: 'github' | 'log',
  command: string,
): Line[] {
  const { shown } = report;
  const file = fileName(report.configFile);
  const head = `${hostKeyLabel}${shown.fingerprint}  `;
  switch (report.state) {
    case 'same':
      return [
        [head, style('saved', 'green')],
        [],
        [
          '  ',
          style('✓ Already saved:', 'boldGreen'),
          ` ${file} holds this key (hostKey${lineOf(report.saved?.place.line)}).`,
        ],
      ];
    case 'not-saved':
      return [
        [head, style('not saved', 'yellow')],
        [],
        ...(asking
          ? [
              [
                `  This is the server's ${keyType(shown.type)} key. Compare the fingerprint with the one in`,
              ],
              ["  your host's control panel (SSH settings), or ask their support."],
              ['  If they match, this is your server.'],
            ]
          : [
              [
                `  Nothing was saved: ${
                  where === 'github'
                    ? 'sealup never trusts a server key from CI.'
                    : 'sealup saves a key only after a yes on a terminal.'
                }`,
              ],
              ["  Compare the fingerprint with your host's control panel, then paste this"],
              [
                `  line into ${file} yourself (or run ${command} ${
                  where === 'github' ? 'on your computer' : 'on a terminal'
                }):`,
              ],
              [],
              pasteLine(report),
            ]),
      ];
    case 'other':
      return [
        [head, style('changed', 'boldRed')],
        [],
        ...(asking
          ? [
              [
                '  ',
                style('!', 'yellow'),
                ' ',
                style(`The server's host key changed: ${file} holds another one.`, 'bold'),
              ],
              ...changedLines(report, file).map((text): Line => [`    ${text}`]),
              ["    Ask your host for the server's fingerprint, and replace the saved key"],
              ['    only if it is the received one.'],
            ]
          : []),
      ];
  }
}

/**
 * The key's line of the target block, then, for a hostKey read from `variable`: already saved,
 * the line and the variable to set, or (another key) nothing: the problem follows.
 */
function inVariableLines(report: KeyscanReport, variable: string): Line[] {
  const { shown } = report;
  const file = fileName(report.configFile);
  const head = `${hostKeyLabel}${shown.fingerprint}  `;
  switch (report.state) {
    case 'same':
      return [
        [head, style('saved', 'green')],
        [],
        [
          '  ',
          style('✓ Already saved:', 'boldGreen'),
          ` ${variable} holds this key (hostKey${lineOf(report.saved?.place.line)}).`,
        ],
      ];
    case 'not-saved':
      return [
        [head, style('not saved', 'yellow')],
        [],
        [`  Nothing was saved: ${file} reads hostKey from a variable, which sealup`],
        ["  never writes. Compare the fingerprint with your host's control panel,"],
        [`  then set ${variable} to this line in sealup.env and in CI:`],
        [],
        [`  ${shown.line}`],
        [],
        ['  ', style(`More: sealup.dev/e/${keyInVariable}`, 'dim')],
      ];
    case 'other':
      return [[head, style('changed', 'boldRed')], []];
  }
}

/** The line to paste into sealup.yml. */
function pasteLine(report: KeyscanReport): Line {
  return [`  hostKey: ${report.shown.line}`];
}

/** S17's lines: where the saved key is, both fingerprints, and the two plain causes. */
function changedLines(
  facts: Pick<KeyscanReport, 'server' | 'shown' | 'saved'>,
  file: string,
): string[] {
  const { saved, shown } = facts;
  return [
    `${file}${saved?.place.line === undefined ? '' : ` (line ${saved.place.line})`} expects one key; ${facts.server.host} sent another:`,
    ...(saved === undefined
      ? []
      : [`  expected  ${keyType(saved.key.type)} ${saved.key.fingerprint}`]),
    `  received  ${keyType(shown.type)} ${shown.fingerprint}`,
    'Either your host moved the site to a new server, or someone between you',
    'and the server is intercepting the connection.',
  ];
}

/** `, line 3`, or nothing. */
function lineOf(line: number | undefined): string {
  return line === undefined ? '' : `, line ${line}`;
}

/**
 * The words of a key not replaced (exit 4): after a no, short (the fingerprints are on the
 * screen already); without a terminal, S17's fingerprints and how to replace it.
 */
export function explainNotReplaced(
  problem: Extract<Problem, { code: 'host-key-not-replaced' }>,
  ci: boolean,
): Explained {
  const file = fileName(problem.configFile);
  const command = `sealup keyscan ${problem.target}`;
  const facts = {
    server: problem.server,
    shown: problem.received,
    saved: { key: problem.expected, place: problem.place },
  };
  if (problem.variable !== undefined) {
    return {
      title: `The server's host key changed. ${file} was not changed.`,
      details: [
        ...changedLines(facts, file),
        ...setVariableLines('hostKey', file, problem.variable, problem.received.line),
      ],
      state: ['Nothing was changed.'],
      slug: keyInVariable,
    };
  }
  if (problem.asked) {
    return {
      title: `The saved host key was kept: ${file} was not changed.`,
      details: [
        `A deploy to ${problem.target} stops before logging in while ${problem.server.host}`,
        'shows another key.',
      ],
      state: ['Nothing was changed.'],
      slug: 'host-key-not-replaced',
    };
  }
  return {
    title: `The server's host key changed. ${file} was not changed.`,
    details: [
      ...changedLines(facts, file),
      ...(ci
        ? [
            "Ask your host for the server's fingerprint. If it is the received one, on",
            `your machine:  ${command}   then commit ${file}.`,
          ]
        : [
            "Ask your host for the server's fingerprint. If it is the received one, run",
            `on a terminal:  ${command}   and answer yes.`,
          ]),
    ],
    state: ['Nothing was changed.'],
    slug: 'host-key-not-replaced',
  };
}
