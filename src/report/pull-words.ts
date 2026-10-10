// The words of `sealup pull`'s problems (decision 0024 §5, S25): what happened, the cause and one
// fix, the state, the docs slug. A pull never changes the server; its state line says what
// arrived here. Pure (import rules, pure file): no node: import.

import { type Problem, type Target, TransportError, type UnsafeName } from '../contracts/index.ts';
import { fileName, formatCount, plural, printable } from './format.ts';
import type { Explained } from './problems.ts';
import { serverSentence, transportSlug } from './server-words.ts';

/** The problems only a pull stops on. */
export type PullProblem = Extract<
  Problem,
  {
    code:
      | 'pull-in-ci'
      | 'no-pull-entries'
      | 'pull-unsafe-name'
      | 'pull-local-path'
      | 'pull-too-large'
      | 'pull-part-way';
  }
>;

/** Why a server name cannot be written here (R10, the Windows rules), one sentence each. */
const unsafeNames: Readonly<Record<UnsafeName, string>> = {
  'dot-name': 'The server listed a name that is not one (empty, . or ..).',
  slash: 'Its name holds a /: a path, not a name.',
  backslash: 'Its name holds a \\, which Windows reads as a folder separator.',
  'control-character': 'Its name holds a control character (a line break, a tab, …).',
  'not-nfc': 'Its name is not in the composed Unicode form (NFC) sealup writes.',
  'windows-character': 'Its name holds < > : " | ? or *, which Windows does not allow.',
  'windows-reserved': 'Its name is reserved on Windows (CON, NUL, COM1, …).',
  'trailing-dot-space': 'Its name ends with a dot or a space, which Windows drops.',
  'too-long': 'Its name is over 255 bytes.',
  'sealup-temp': "Its name has the form of sealup's own temp files.",
};

const kinds = { link: 'link', file: 'file', folder: 'folder', other: 'special file' } as const;

export function explainPull(problem: PullProblem, target: Target | undefined): Explained {
  const name = 'target' in problem ? problem.target : undefined;
  const nothing = [
    `Nothing was downloaded. Nothing was changed${name === undefined ? '' : ` on ${name}`}.`,
  ];
  switch (problem.code) {
    case 'pull-in-ci':
      return {
        title: 'sealup pull does not run in CI.',
        details: [
          'It copies server files to the machine it runs on, and a CI runner is',
          'thrown away when the job ends, so the files would go with it.',
          `Run it on your own machine:  sealup pull${name === undefined ? '' : ` ${name}`}`,
        ],
        state: nothing,
        slug: 'pull-in-ci',
      };
    case 'no-pull-entries':
      return {
        title: `${fileName(problem.configFile)} has no pull: entries for ${problem.target}.`,
        details: [
          'Add the server folder to copy and the local folder it goes to, like:',
          '  pull:',
          '    www/resources: public_html/resources',
        ],
        state: [`sealup did not connect. ${nothing[0]}`],
        slug: 'no-pull-entries',
      };
    case 'pull-unsafe-name':
      return {
        title: `${printable(problem.path)} cannot be pulled as it is named.`,
        details: [
          unsafeNames[problem.reason],
          'sealup stopped before writing anything here. Rename it on the server,',
          'or pull a folder that does not hold it.',
        ],
        state: nothing,
        slug: 'pull-unsafe-name',
      };
    case 'pull-local-path':
      return problem.found === 'link'
        ? {
            title: `${problem.path} is a link: sealup pull stopped before writing anything.`,
            details: [
              'sealup does not write through links: one could lead outside the project.',
              'Put a real folder there, or pull into another folder.',
            ],
            state: nothing,
            slug: 'pull-local-path',
          }
        : {
            title: `${problem.path} is a ${kinds[problem.found]}; the pull needs a ${problem.needs} there.`,
            details: [
              'sealup never deletes a local file or folder to make room.',
              `Move it out of the way, or pull into another folder.`,
            ],
            state: nothing,
            slug: 'pull-local-path',
          };
    case 'pull-too-large':
      return {
        title: {
          entries: `${problem.path} holds over ${formatCount(problem.max)} entries: sealup stopped listing.`,
          files: `The server holds over ${formatCount(problem.max)} files to pull: sealup stopped listing.`,
          depth: `${problem.path} is over ${formatCount(problem.max)} folders deep: sealup stopped listing.`,
        }[problem.limit],
        details: [
          'sealup reads only that much from a server, so a broken or hostile one',
          'cannot keep it listing. Pull a smaller folder.',
        ],
        state: nothing,
        slug: 'pull-too-large',
      };
    case 'pull-part-way': {
      const { error } = problem;
      const state = [
        `${formatCount(problem.downloaded)} of ${plural(problem.downloads, 'file')} arrived here; they stay.`,
        'Run the same command again to finish.',
      ];
      if (error === undefined) {
        return {
          title: 'Stopped: sealup was interrupted (Ctrl-C).',
          details: ['The downloads in flight finished; no new one started.'],
          state,
          slug: 'interrupted',
        };
      }
      if (error instanceof TransportError) {
        return {
          title: serverSentence(error, target?.server.host),
          details: [],
          state,
          slug: transportSlug(error),
        };
      }
      return {
        title: 'sealup stopped on an error it did not expect.',
        details: ['Run the same command with --debug to see where, and report it.'],
        state,
        slug: 'internal-error',
      };
    }
  }
}
