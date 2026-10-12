// The words of `sealup init` (S02, spec #24 decisions 19-21): what it found in the project, the
// server question and its refusals, the password's line, the files written with `+`/`~`, the
// secret to add on GitHub and the next commands; and the words of its two problems (no terminal,
// a sealup.yml already there). The sam-sync conversion's words (S03, #37: undocumented, so only
// shown when a sam-sync file is there): the offer, what was converted and left out, and the
// warning to delete the old files and change the password. Pure (import rules, pure file): no
// node: import.

import type { Problem } from '../contracts/index.ts';
import { fileName, type Line, plural, style } from './format.ts';
import type { Explained } from './problems.ts';

/** A file init wrote or left: its path from the current folder, `/`-separated. */
interface InitFileShown {
  readonly path: string;
  readonly kind: 'config' | 'env' | 'gitignore' | 'workflow';
  readonly change: 'added' | 'changed' | 'left';
  /** sealup.env: the variables added to it (default: the password's). */
  readonly variables?: readonly string[];
}

/** One step of init's output, in the order cli prints them. */
export type InitStep =
  /**
   * What init found: the upload folder (`found` with its file count; `asked` when it will ask;
   * else the folder it takes without asking) and the build command, if any.
   */
  | {
      readonly kind: 'project';
      readonly upload:
        | { readonly found: string; readonly files: number }
        | { readonly asked: true }
        | { readonly assumed: string };
      readonly build?: string;
    }
  /** The server question's explanation (S02, dim). */
  | { readonly kind: 'server-intro' }
  /** The answer cannot be a server: not a URL sealup reads. */
  | { readonly kind: 'server-refused' }
  /** The upload folder answered is not a folder of this project. */
  | { readonly kind: 'upload-refused' }
  /**
   * Before the public-repository question (0045): what a yes keeps out of sealup.yml, the server
   * and, when one was saved (`hostKey`), its host key.
   */
  | { readonly kind: 'public-intro'; readonly hostKey: boolean }
  /** Where the password goes; or that sealup.env already holds it (no question then). */
  | { readonly kind: 'password-intro'; readonly kept: boolean }
  /** The password typed cannot be used or written (config's reason). */
  | {
      readonly kind: 'password-refused';
      readonly reason:
        | 'too-short'
        | 'surrounding-whitespace'
        | 'forbidden-character'
        | 'cannot-quote';
    }
  /** A sam-sync setup was found (#37): its files, before the offer to convert it. */
  | { readonly kind: 'sam-sync-found'; readonly files: readonly string[] }
  /** What the sam-sync conversion made of the files, and what it left out (S03). */
  | ConvertedStep
  /** Before the host key of a converted project: sam-sync never checked it. */
  | { readonly kind: 'sam-sync-key' }
  /**
   * The end: the files (`+` added, `~` changed, a dim line for one left as it was), the secret
   * to add on GitHub and the next commands. `hostKey`: saved in sealup.yml (`none`: plain FTP or
   * FTPS, which have none to save, spec #41 decision 12). `terminal`: the
   * password was asked here (else the words of a run without a terminal). `samSync`: the
   * project was converted (S03): its files, the package.json scripts that call sam-sync,
   * whether it pulls, whether its files held the password; `secrets`: the variables to add on
   * GitHub (default: the password's). `public`: the server (and host key) went to sealup.env
   * (0045), so the secrets' values are there to copy.
   */
  | {
      readonly kind: 'done';
      readonly files: readonly InitFileShown[];
      readonly upload: string;
      readonly build: boolean;
      readonly hostKey: boolean | 'none';
      readonly host: string;
      readonly terminal: boolean;
      readonly secrets?: readonly string[];
      readonly public?: boolean;
      readonly samSync?: {
        readonly files: readonly string[];
        readonly scripts: readonly string[];
        readonly pull: boolean;
        readonly password: boolean;
      };
    };

/** Why an entry of the sam-sync files is not in sealup.yml (init's LeftOutReason). */
type LeftOut = 'outside' | 'project-folder' | 'excluded' | 'twice';

/** Why a secret of the sam-sync files did not go to sealup.env. */
type NotMoved =
  | 'missing'
  | 'no-password'
  | 'too-short'
  | 'surrounding-whitespace'
  | 'forbidden-character'
  | 'cannot-quote';

interface ConvertedStep {
  readonly kind: 'converted';
  readonly server: string;
  /** `local → remote`, sent as a folder or a single file; `variable`: written from it. */
  readonly folders: readonly { readonly local: string; readonly remote: string }[];
  readonly exclude: readonly string[];
  readonly files: readonly {
    readonly local: string;
    readonly remote: string;
    readonly variable?: string;
  }[];
  readonly pulls: readonly {
    readonly remote: string;
    readonly local: string;
    readonly kind: 'folder' | 'file';
  }[];
  /** Moved to sealup.env: the variable, and the local file of a file's content. */
  readonly secrets: readonly { readonly name: string; readonly from?: string }[];
  /** Not moved, and why: the variable, and the local file of a file's content. */
  readonly notMoved: readonly {
    readonly name: string;
    readonly from?: string;
    readonly reason: NotMoved;
  }[];
  readonly dropped: readonly ('verbose' | 'dry')[];
  readonly download?: { readonly name: string; readonly same: boolean };
  readonly pullExcludes: readonly string[];
  readonly leftOut: readonly {
    readonly from: string;
    readonly to: string;
    readonly reason: LeftOut;
  }[];
}

/** The variable init writes the password to (0022 §6). */
const secret = 'SEALUP_PASSWORD';

/** The public-repository question (0045), after its `public-intro`; cli asks it, default no. */
export const publicQuestion = '  Is this repository public?';

const labels = (label: string, value: Line): Line => [`  ${label.padEnd(16)}`, ...value];

const refusals = {
  'too-short': 'it has fewer than 6 characters, too short to hide in logs',
  'surrounding-whitespace': 'it starts or ends with a space',
  'forbidden-character': 'it holds a line break',
  'cannot-quote': 'sealup.env has no way to hold it as typed',
} as const;

export function initLines(step: InitStep): Line[] {
  switch (step.kind) {
    case 'project': {
      const { upload } = step;
      const uploadLine: Line =
        'found' in upload
          ? [`${upload.found}/  `, style(`(found, ${plural(upload.files, 'file')})`, 'dim')]
          : 'asked' in upload
            ? [style('none found in dist/, build/, out/, public/ or _site/', 'dim')]
            : [
                `${upload.assumed}/  `,
                style('(none found: change upload: in sealup.yml if needed)', 'dim'),
              ];
      const buildLine: Line =
        step.build === undefined
          ? ['none  ', style('(no build script in package.json: the workflow only deploys)', 'dim')]
          : [`${step.build}  `, style('(from package.json, for the GitHub workflow)', 'dim')];
      return [labels('Upload folder', uploadLine), labels('Build', buildLine)];
    }
    case 'server-intro':
      return [
        ['  ', style('Where should it go? A URL like sftp://user@host/folder', 'dim')],
        ['  ', style('(also ssh://, ftps://, or ftp:// for plain FTP)', 'dim')],
      ];
    case 'server-refused':
      return [refused('Not an address sealup can use: write it as sftp://user@host/folder.')];
    case 'upload-refused':
      return [refused('Name a folder inside this one, such as dist.')];
    case 'public-intro':
      return [
        [],
        [
          '  ',
          style(
            'Anyone can read sealup.yml in a public repository. sealup can keep the server',
            'dim',
          ),
        ],
        [
          '  ',
          style(
            `${step.hostKey ? 'and its host key out' : 'out'} of it: in sealup.env here, and in secrets on GitHub.`,
            'dim',
          ),
        ],
      ];
    case 'password-intro':
      return [
        [],
        [
          '  ',
          style(
            step.kept
              ? `sealup.env already holds ${secret}: it stays as it is.`
              : 'The password goes in sealup.env, which stays on this machine (git-ignored).',
            'dim',
          ),
        ],
      ];
    case 'password-refused':
      return [refused(`sealup cannot use this password: ${refusals[step.reason]}.`)];
    case 'done':
      return doneLines(step);
    case 'sam-sync-found':
      return [[`  Found a sam-sync setup: ${and(step.files)}.`]];
    case 'converted':
      return convertedLines(step);
    case 'sam-sync-key':
      return [["  sam-sync never checked the server's identity. sealup does, before each login:"]];
  }
}

/** `a`, `a and b`, `a, b and c`. */
function and(items: readonly string[]): string {
  return items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Words, each line at most 80 columns, after `indent` (the first line after `first`). */
function wrap(text: string, indent: string, first = indent): string[] {
  const lines: string[] = [];
  let line = first;
  for (const word of text.split(' ')) {
    const start = lines.length === 0 ? first : indent;
    if (line !== start && `${line} ${word}`.length > 80) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = line === start ? `${line}${word}` : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines;
}

/** A dim paragraph at the two-space indent. */
const note = (text: string): Line[] =>
  wrap(text, '  ').map((line): Line => ['  ', style(line.slice(2), 'dim')]);

const leftOutWords: Record<LeftOut, string> = {
  outside: 'it is outside this folder, or outside the server folder.',
  'project-folder': 'sealup never sends or pulls into this whole folder (it holds sealup.env).',
  excluded: 'its folder excludes it, and sealup never sends an excluded file.',
  twice: 'an entry before it has the same path.',
};

const notMovedWords: Record<Exclude<NotMoved, 'missing' | 'no-password'>, string> = {
  'too-short': 'it has fewer than 6 characters',
  'surrounding-whitespace': 'it starts or ends with a space',
  'forbidden-character': 'it holds a line break',
  'cannot-quote': 'sealup.env has no way to hold it as it is',
};

/** S03's "Converted:" block, then a dim paragraph for each thing dropped or left out. */
function convertedLines(step: ConvertedStep): Line[] {
  const labelled = (label: string, items: readonly string[]): Line[] => {
    const head = `    ${label} `.padEnd(20);
    return wrap(items.join(', '), ' '.repeat(20), head).map((line): Line => [line]);
  };
  const each = (label: string, items: readonly string[]): Line[] =>
    items.flatMap((item, index) => labelled(index === 0 ? label : '', [item]));
  const count = (n: number, word: string) => plural(n, word);
  const fileItem = (file: ConvertedStep['files'][number], renamed: boolean): string =>
    `${renamed ? `${file.local} → ${file.remote}` : file.local}${
      file.variable === undefined ? '' : `, now written from $\{${file.variable}}`
    }`;
  const renamed = step.files.filter((file) => file.local !== file.remote);
  const same = step.files.filter((file) => file.local === file.remote);
  const pullFolders = step.pulls.filter((pull) => pull.kind === 'folder');
  const pullFiles = step.pulls.filter((pull) => pull.kind === 'file');
  const arrow = (pull: ConvertedStep['pulls'][number]) => `${pull.remote} → ${pull.local}`;
  const moved =
    step.secrets.length === 1 ? 'moved' : step.secrets.length === 2 ? 'both moved' : 'all moved';
  const lines: Line[] = [
    ['  Converted:'],
    ...labelled('server', [step.server]),
    ...(step.folders.length === 0
      ? []
      : labelled(
          count(step.folders.length, 'folder'),
          step.folders.map(({ local, remote }) => `${local} → ${remote}`),
        )),
    ...(step.exclude.length === 0
      ? []
      : labelled(count(step.exclude.length, 'exclude'), step.exclude)),
    ...each(
      count(renamed.length, 'renamed file'),
      renamed.map((file) => fileItem(file, true)),
    ),
    ...each(
      count(same.length, 'file'),
      same.map((file) => fileItem(file, false)),
    ),
    ...(pullFolders.length === 0
      ? []
      : labelled(count(pullFolders.length, 'pull folder'), pullFolders.map(arrow))),
    ...(pullFiles.length === 0
      ? []
      : labelled(count(pullFiles.length, 'pull file'), pullFiles.map(arrow))),
    ...(step.secrets.length === 0
      ? []
      : [
          ...labelled(
            count(step.secrets.length, 'secret'),
            step.secrets.map(
              ({ name, from }) => `${name} (${from === undefined ? 'the password' : from})`,
            ),
          ),
          [' '.repeat(20), style(`${moved} to sealup.env, never written in sealup.yml`, 'dim')],
        ]),
  ];
  const dropped = step.dropped.map((key) => (key === 'verbose' ? '-v' : '--dry-run'));
  if (step.dropped.length > 0) {
    lines.push(...note(`Not needed any more: ${and(step.dropped)} (use ${and(dropped)}).`));
  }
  if (step.download !== undefined) {
    lines.push(
      ...note(
        step.download.same
          ? `${step.download.name} used the same server, so it became the pull: section.`
          : `${step.download.name} uses another server: it was left out (sealup pulls from the server it deploys to).`,
      ),
    );
  }
  if (step.pullExcludes.length > 0) {
    lines.push(
      ...note(`sealup pull has no exclude: ${and(step.pullExcludes)} will come down too.`),
    );
  }
  for (const { from, to, reason } of step.leftOut) {
    lines.push(...note(`Left out: ${from} → ${to}: ${leftOutWords[reason]}`));
  }
  for (const { name, from, reason } of step.notMoved) {
    const what = from === undefined ? 'the password' : from;
    lines.push(
      ...note(
        reason === 'missing'
          ? `${name}: ${what} is not here. Put its content in sealup.env as ${name}.`
          : reason === 'no-password'
            ? `The sam-sync files hold no password: add ${name} to sealup.env.`
            : `${name}: sealup.env cannot hold ${what} (${notMovedWords[reason]}). Add it by hand.`,
      ),
    );
  }
  return lines;
}

function refused(text: string): Line {
  return ['  ', style('✗', 'red'), ` ${text}`];
}

function doneLines(step: Extract<InitStep, { kind: 'done' }>): Line[] {
  const written = step.files.filter((file) => file.change !== 'left');
  const width = Math.max(...written.map((file) => file.path.length)) + 3;
  const { samSync } = step;
  const secrets = step.secrets ?? [secret];
  const what = (file: InitFileShown): string => {
    switch (file.kind) {
      case 'config': {
        const noKey = step.hostKey ? '' : '; no hostKey yet';
        if (samSync !== undefined) {
          const from =
            samSync.files.length === 1
              ? `from ${samSync.files[0]}`
              : `from your ${samSync.files.length} sam-sync files`;
          return `${from}${noKey}`;
        }
        return step.hostKey === true
          ? `server, password, hostKey, upload: ${step.upload}`
          : `server, password, upload: ${step.upload}${noKey}`;
      }
      case 'env': {
        const added = (file.variables ?? [secret]).join(', ');
        return file.change === 'added' ? `${added} (git-ignored)` : `added ${added}`;
      }
      case 'gitignore':
        return file.change === 'added' ? 'with the line sealup.env' : 'added the line sealup.env';
      case 'workflow':
        return step.build ? 'on push to main: build, then deploy' : 'on push to main: deploy';
    }
  };
  const next: [string, string][] = [
    ...(step.hostKey
      ? []
      : ([['sealup keyscan', "check the server's key and save it"]] as [string, string][])),
    ['sealup deploy --dry-run', 'dry run: list every change, change nothing'],
    ['sealup deploy', `deploy to ${step.host}`],
  ];
  const commandWidth = Math.max(...next.map(([command]) => command.length)) + 4;
  return [
    [],
    step.hostKey
      ? ['  ', style('✓ This project is set up.', 'boldGreen'), ' Files written:']
      : ['  ', style('✓ Files written:', 'boldGreen')],
    ...written.map(
      (file): Line => [
        '    ',
        ...(file.change === 'added' ? [style('+', 'green')] : ['~']),
        ` ${file.path.padEnd(width)}${what(file)}`,
      ],
    ),
    ...step.files
      .filter((file) => file.change === 'left')
      .map((file): Line => ['  ', style(`${file.path} is there already: left as it is.`, 'dim')]),
    ...(samSync === undefined || samSync.scripts.length === 0
      ? []
      : note(
          `package.json still calls sam-sync in ${and(samSync.scripts)}: change ${
            samSync.scripts.length === 1 ? 'it' : 'them'
          } to sealup deploy${samSync.pull ? ' and sealup pull' : ''}.`,
        )),
    [],
    secrets.length === 1
      ? [
          '  On GitHub, add the secret ',
          style(secrets[0] ?? secret, 'bold'),
          step.terminal ? ' with the same password:' : " with the server's password:",
        ]
      : [
          '  On GitHub, add the secrets ',
          ...secrets.flatMap((name, index) => [
            ...(index === 0 ? [] : [index === secrets.length - 1 ? ' and ' : ', ']),
            style(name, 'bold'),
          ]),
          ':',
        ],
    ['  ', style('Settings › Secrets and variables › Actions › New repository secret', 'dim')],
    ...(step.public === true ? [['  ', style('Copy each value from sealup.env.', 'dim')]] : []),
    [],
    ...(samSync === undefined
      ? []
      : [
          [
            '  ',
            style('!', 'yellow'),
            ' ',
            style(
              samSync.password
                ? 'The old sam-sync files hold your password, and git history keeps it.'
                : 'The old sam-sync files are not needed any more.',
              'bold',
            ),
          ],
          [`    Delete them:  git rm ${samSync.files.join(' ')}  then commit.`],
          ...(samSync.password
            ? [[`    Then change the password on the host, in sealup.env and in ${secret}.`]]
            : []),
          [],
        ]),
    ['  ', style(step.terminal ? 'Next:' : 'Next, on your computer:', 'bold')],
    ...next.map(([command, text]): Line => [`    ${command.padEnd(commandWidth)}${text}`]),
  ];
}

/** The words of init's problems: no terminal to ask in (S02's CI form), sealup.yml already there. */
export function explainInit(
  problem: Extract<Problem, { code: 'no-terminal' | 'config-exists' }>,
): Explained {
  if (problem.code === 'config-exists') {
    const file = fileName(problem.file);
    return {
      title: `${file} is already here: sealup init never overwrites it.`,
      details: [
        'This project is set up. Its targets and commands:  sealup',
        `To start again, move ${file} away first.`,
      ],
      state: ['Nothing was written.'],
      slug: 'config-exists',
    };
  }
  return {
    title: 'sealup init needs the server address.',
    details: [
      'There is no terminal to ask in, so pass it as a flag:',
      'sealup init --server sftp://user@host/folder',
      ...(problem.deploymentJson
        ? ['(or --from .deployment.json to convert a sam-sync config)']
        : []),
    ],
    state: ['Nothing was written.'],
    slug: 'no-terminal',
  };
}
