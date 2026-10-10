// The words of `sealup keyscan` on an `ftps://` target (spec #41 decision 12, R7, R8): the target
// block with the certificate, its facts to compare with the host's, then by state: nothing to pin
// (a trusted certificate), the pin offered or the line to paste (the normal check fails), already
// pinned, or another certificate than the pinned one. Pure (import rules, pure file): no node:
// import.

import type { CertificateReport, Problem } from '../contracts/index.ts';
import { certificateLines, fileName, type Line, style } from './format.ts';
import type { Explained } from './problems.ts';
import { certificateFacts } from './tls-words.ts';

/** One step of an `ftps://` keyscan's output, after the target line, in the order cli prints. */
export type CertificateStep =
  /**
   * The certificate shown, its facts, then what its state calls for: without a terminal
   * (`asking` false), the line to paste (`where`: GitHub's words, or a plain log's). `again`: the
   * words after `sealup keyscan` to run it again for this target.
   */
  | {
      readonly kind: 'certificate-found';
      readonly report: CertificateReport;
      readonly asking: boolean;
      readonly where: 'github' | 'log';
      readonly again: readonly string[];
    }
  /** The pin now in the file, on `line`. */
  | {
      readonly kind: 'certificate-saved';
      readonly report: CertificateReport;
      readonly line: number;
    }
  /** Not pinned: the answer was no, or sealup could not edit the file. The line to paste follows. */
  | {
      readonly kind: 'certificate-kept';
      readonly report: CertificateReport;
      readonly reason: 'answered-no' | 'cannot-edit';
      readonly again: readonly string[];
    };

/** Why the normal check fails, in one sentence. */
function failure(report: CertificateReport): string {
  return report.shown.check === 'other-name'
    ? `It is signed by a known authority, but for another host than ${report.server.host}.`
    : 'It is signed by no known authority (self-signed), or it is out of date.';
}

/** The lines of one step. `quote` makes a word of a command safe to copy. */
export function certificateScanLines(
  step: CertificateStep,
  quote: (word: string) => string,
): Line[] {
  const command = (again: readonly string[]): string =>
    ['sealup', 'keyscan', ...again].map(quote).join(' ');
  const { report } = step;
  const file = fileName(report.configFile);
  switch (step.kind) {
    case 'certificate-found':
      return [...foundHead(report), [], ...foundTail(step, file, command(step.again))];
    case 'certificate-saved':
      return [
        [],
        [
          '  ',
          style(report.state === 'other' ? '✓ Replaced.' : '✓ Pinned.', 'boldGreen'),
          ` ${file} now holds this certificate (tlsFingerprint, line ${step.line}).`,
        ],
        ['    From now on the server must show it before sealup sends your user name.'],
        ['    When your host renews it, check the new one and run keyscan again.'],
      ];
    case 'certificate-kept': {
      const first =
        step.reason === 'answered-no'
          ? [
              '  Nothing was saved. To pin this certificate later, paste this line into',
              `  ${file} yourself (or run ${command(step.again)} again):`,
            ]
          : [
              `  Nothing was saved: ${file} writes this target on one line ({ … }),`,
              '  where sealup cannot add a line. Paste this line into it yourself:',
            ];
      return [[], ...first.map((text): Line => [text]), [], pasteLine(report)];
    }
  }
}

/** The target block's certificate lines, with the state as the run's block words it. */
function foundHead(report: CertificateReport): Line[] {
  const { certificate } = report.shown;
  switch (report.state) {
    case 'trusted':
      return certificateLines(certificate, style('verified', 'green'));
    case 'same':
      return certificateLines(certificate, style('pinned', 'green'));
    case 'not-saved':
      return certificateLines(certificate, style('not pinned', 'yellow'));
    case 'other':
      return certificateLines(certificate, style('changed', 'boldRed'));
  }
}

function foundTail(
  step: Extract<CertificateStep, { kind: 'certificate-found' }>,
  file: string,
  command: string,
): Line[] {
  const { report, asking, where } = step;
  const facts = certificateFacts(report.shown.certificate).map((text): Line => [`  ${text}`]);
  switch (report.state) {
    case 'trusted':
      return [
        ...facts,
        [],
        [
          '  ',
          style('✓ Trusted:', 'boldGreen'),
          ` a known authority signs it for ${report.server.host}. Nothing to pin.`,
        ],
      ];
    case 'same':
      return [
        ...facts,
        [],
        [
          '  ',
          style('✓ Already pinned:', 'boldGreen'),
          ` ${file} holds this certificate (tlsFingerprint${lineOf(report.saved?.place.line)}).`,
        ],
      ];
    case 'not-saved':
      return [
        ...facts,
        [],
        [`  ${failure(report)}`],
        ...(asking
          ? [
              ['  Compare the SHA-256 with the one your host gives (its panel or support).'],
              ['  If they match, this is your server: pin it, and sealup checks it on every run.'],
            ]
          : [
              [
                `  Nothing was saved: ${
                  where === 'github'
                    ? 'sealup never trusts a certificate from CI.'
                    : 'sealup pins a certificate only after a yes on a terminal.'
                }`,
              ],
              ["  Compare the SHA-256 with your host's, then paste this line into"],
              [
                `  ${file} yourself (or run ${command} ${
                  where === 'github' ? 'on your computer' : 'on a terminal'
                }):`,
              ],
              [],
              pasteLine(report),
            ]),
      ];
    case 'other':
      return [
        ...facts,
        [],
        ...(asking
          ? [
              [
                '  ',
                style('!', 'yellow'),
                ' ',
                style(`The server's TLS certificate changed: ${file} pins another one.`, 'bold'),
              ],
              ...changedLines(pinFacts(report), file).map((text): Line => [`    ${text}`]),
              ["    Ask your host for the certificate's SHA-256, and replace the pin only"],
              ['    if it is the received one.'],
            ]
          : []),
      ];
  }
}

/** The line to paste into sealup.yml. */
function pasteLine(report: CertificateReport): Line {
  return [`  tlsFingerprint: ${report.shown.certificate.sha256}`];
}

/** A pin and the certificate shown instead. */
interface PinFacts {
  readonly host: string;
  readonly expected: string | undefined;
  readonly line: number | undefined;
  readonly received: string;
}

function pinFacts(report: CertificateReport): PinFacts {
  return {
    host: report.server.host,
    expected: report.saved?.sha256,
    line: report.saved?.place.line,
    received: report.shown.certificate.sha256,
  };
}

/** Where the pin is, both SHA-256s, and the two plain causes. */
function changedLines(facts: PinFacts, file: string): string[] {
  return [
    `${file}${facts.line === undefined ? '' : ` (line ${facts.line})`} pins one certificate; ${facts.host} showed another:`,
    ...(facts.expected === undefined ? [] : [`  expected  SHA-256 ${facts.expected}`]),
    `  received  SHA-256 ${facts.received}`,
    'Either your host renewed or replaced its certificate, or someone between',
    'you and the server is intercepting the connection.',
  ];
}

/** `, line 3`, or nothing. */
function lineOf(line: number | undefined): string {
  return line === undefined ? '' : `, line ${line}`;
}

/**
 * The words of a pin not replaced (exit 4): after a no, short (the SHA-256s are on the screen);
 * without a terminal, both SHA-256s and how to replace it.
 */
export function explainPinNotReplaced(
  problem: Extract<Problem, { code: 'certificate-not-replaced' }>,
  ci: boolean,
): Explained {
  const file = fileName(problem.configFile);
  const command = `sealup keyscan ${problem.target}`;
  if (problem.asked) {
    return {
      title: `The pinned certificate was kept: ${file} was not changed.`,
      details: [
        `A deploy to ${problem.target} stops before logging in while ${problem.server.host}`,
        'shows another certificate.',
      ],
      state: ['Nothing was changed.'],
      slug: 'certificate-refused',
    };
  }
  const facts: PinFacts = {
    host: problem.server.host,
    expected: problem.expected,
    line: problem.place.line,
    received: problem.received.sha256,
  };
  return {
    title: `The server's TLS certificate changed. ${file} was not changed.`,
    details: [
      ...changedLines(facts, file),
      ...(ci
        ? [
            "Ask your host for the certificate's SHA-256. If it is the received one, on",
            `your machine:  ${command}   then commit ${file}.`,
          ]
        : [
            "Ask your host for the certificate's SHA-256. If it is the received one, run",
            `on a terminal:  ${command}   and answer yes.`,
          ]),
    ],
    state: ['Nothing was changed.'],
    slug: 'certificate-refused',
  };
}
