// The words of a problem (decision 0024 §5): what happened, the likely cause and one fix, the
// state of the server, the docs slug; laid out for the terminal (problemLines) and given whole
// to `--json` (explain, fixLines). Pure (import rules, pure file): no node: import. The words
// come from the Problem's facts only; no module upstream words anything. Some problems have
// their own file: a command line (usage-words.ts), a run stopped on the server or a path in the
// way (stopped-words.ts), a connect that failed before login (login-words.ts), a private key
// sealup cannot read (key-words.ts), the config (config-words.ts), pull (pull-words.ts), the lock
// (lock-words.ts), keyscan and init.

import type { Problem, Target } from '../contracts/index.ts';
import { explainPinNotReplaced } from './certificate-scan.ts';
import { explainConfig } from './config-words.ts';
import { fileName, type Line, lineOf, printable, style } from './format.ts';
import { explainInit } from './init.ts';
import { explainKey } from './key-words.ts';
import { explainNotReplaced } from './keyscan.ts';
import { explainListing } from './listing-words.ts';
import { explainLockHeld } from './lock-words.ts';
import { explainBeforeLogin } from './login-words.ts';
import { explainPull } from './pull-words.ts';
import { serverSentence, transportSlug } from './server-words.ts';
import { explainInTheWay, explainStopped, partialState } from './stopped-words.ts';
import { explainTls } from './tls-words.ts';
import { usageDetails, usageTitle } from './usage-words.ts';

export { serverSentence };

/** Every docs slug sealup links (`sealup.dev/e/<slug>`), so the docs site can list them. */
export const docsSlugs = [
  // On the CLI page.
  'target-not-named',
  'unknown-target',
  'variable-not-set',
  'secret-in-config',
  'host-key-missing',
  'host-key-changed',
  'login-refused',
  'wrong-protocol',
  'quota-full',
  'empty-source',
  // Not on the page; named here (ruling 9).
  'usage',
  'not-available-yet',
  'config-not-found',
  'config-ambiguous',
  'env-file-not-found',
  'config-invalid',
  'symlink',
  'manifest-inside-target',
  'manifest-unreadable',
  'manifest-invalid',
  'manifest-too-large',
  'unreachable',
  'connection-lost',
  'timeout',
  'permission-denied',
  'server-not-found',
  'protocol-error',
  'interrupted',
  'internal-error',
  'bad-local-name',
  'path-in-the-way',
  // Lane C (spec #24 decision 8).
  'same-server-path',
  'excluded-file',
  'secret-file-public',
  'cancelled',
  'pull-in-ci',
  'no-pull-entries',
  'pull-unsafe-name',
  'pull-local-path',
  'pull-too-large',
  'host-key-not-replaced',
  'no-terminal',
  'config-exists',
  // Lanes A and B (spec #41).
  'listing-too-large',
  // Plan 05, lane A (decision 0033).
  'private-key-unreadable',
  // Plan 05, lane B (decision 0031).
  'lock-held',
  // Plan 05, lane A: FTPS (R8, spec #41 decision 8).
  'tls-refused',
  'certificate-refused',
  // Plan 05, lane B: the risky-folder net (decision 0029).
  'risky-folder',
  // Plan 06 spec #88 decision 8: a hostKey or tlsFingerprint read from a variable.
  'key-in-variable',
] as const;

export type Slug = (typeof docsSlugs)[number];

/** A problem in words: what happened, the cause and fix, the state of the server, its slug. */
export interface Explained {
  readonly title: string;
  /** Plain text lines are indented 4; a Line (a file list entry) is printed as it is. */
  readonly details: readonly (string | Line)[];
  /** A last fix line said quietly (dim on a terminal): S21's opt-out. */
  readonly hint?: string;
  readonly state: readonly string[];
  readonly slug: Slug;
}

/** The fix lines of a problem, the hint last: what `--json` puts in `error.fix`. */
export function fixLines(explained: Explained): string[] {
  const { details, hint } = explained;
  const lines = details.map(detailText);
  return hint === undefined ? lines : [...lines, hint];
}

/**
 * An error (decision 0024 §5): `✗` and what happened, the likely cause and one fix, a blank
 * line, the state line (what changed on the server), the docs link.
 */
export function problemLines(
  problem: Problem,
  target: Target | undefined,
  configFile = 'sealup.yml',
  ci = false,
): Line[] {
  const { title, details, hint, state, slug } = explain(problem, target, configFile, ci);
  return [
    ['  ', style('✗', 'boldRed'), ' ', style(title, 'bold')],
    ...details.map((text): Line => (typeof text === 'string' ? [`    ${text}`] : text)),
    ...(hint === undefined ? [] : [['    ', style(hint, 'dim')] satisfies Line]),
    [],
    ...state.map((text): Line => [`    ${text}`]),
    ['    ', style(`More: sealup.dev/e/${slug}`, 'dim')],
  ];
}

/**
 * `--debug` only: a blank line, then the stack of the error behind the problem and of its
 * causes, dim (it may pass 80 columns). Nothing for a problem that holds no error.
 */
export function debugLines(problem: Problem): Line[] {
  let error: unknown = 'error' in problem ? problem.error : undefined;
  if (!(error instanceof Error)) return [];
  const lines: Line[] = [[]];
  for (let depth = 0; error instanceof Error && depth < 5; depth++) {
    const stack = error.stack ?? `${error.name}: ${error.message}`;
    for (const text of stack.split('\n')) lines.push(['    ', style(text.trim(), 'dim')]);
    error = error.cause;
  }
  return lines;
}

/** A detail of an Explained as plain text, as `--json` gives it (a file list entry trimmed). */
function detailText(detail: string | Line): string {
  if (typeof detail === 'string') return detail;
  return detail
    .map((segment) => (typeof segment === 'string' ? segment : segment.text))
    .join('')
    .trim();
}

/**
 * The words of a problem, for the terminal (problemLines) and for `--json` (`error`). `ci`: the
 * GitHub form's words, where the fix differs in CI (the page's S14-S17, S21): a secret instead of
 * sealup.env, keyscan on your machine, the build step.
 */
export function explain(
  problem: Problem,
  target: Target | undefined,
  configFile: string,
  ci = false,
): Explained {
  const nothing =
    target === undefined ? 'Nothing was changed.' : `Nothing was changed on ${target.name}.`;
  switch (problem.code) {
    case 'usage':
      return {
        title: usageTitle(problem),
        details: usageDetails(problem),
        state: ['Nothing was changed.'],
        slug: 'usage',
      };
    case 'not-available-yet':
      return {
        title: `${problem.what} is not available yet in this version.`,
        details: ['sealup stops rather than ignore it.'],
        state: ['Nothing was changed.'],
        slug: 'not-available-yet',
      };
    case 'config':
      return explainConfig(problem.issues, problem.target, ci);
    case 'no-terminal':
    case 'config-exists':
      return explainInit(problem);
    case 'unknown-target': {
      const file = fileName(problem.configFile);
      const { suggestion } = problem;
      return {
        title: `No target named ${problem.name} in ${file}.`,
        details: [
          ...(suggestion === undefined
            ? []
            : [`Did you mean ${suggestion}?  sealup ${problem.command ?? 'deploy'} ${suggestion}`]),
          `Targets in ${file}: ${problem.names.join(', ')}.`,
        ],
        state: ['Nothing was changed.'],
        slug: 'unknown-target',
      };
    }
    case 'target-not-named':
      return {
        title: `Which target? ${fileName(problem.configFile)} has ${problem.names.length} and none was named.`,
        // A terminal asks with the picker; this comes without one (S12), or with stdin piped.
        details: [
          `${ci ? 'In CI sealup never asks.' : 'sealup asks only on a terminal.'} Name the target in the command:`,
          ...problem.names.map((name) => `  sealup ${problem.command ?? 'deploy'} ${name}`),
          // The action deploys: its input names a deploy's target only.
          ...(ci && problem.names[0] !== undefined && (problem.command ?? 'deploy') === 'deploy'
            ? [`With the GitHub action, set its target input:  target: ${problem.names[0]}`]
            : []),
        ],
        state: ['Nothing was changed.'],
        slug: 'target-not-named',
      };
    case 'host-key-missing': {
      const name = target?.name ?? 'the target';
      const file = fileName(problem.configFile);
      return {
        title: 'sealup cannot confirm this server is yours: there is no host key.',
        details: [
          'It checks the server first, so an impostor never receives the password.',
          ...(ci
            ? [
                "sealup never trusts a new key in CI: it could be anyone's.",
                `On your machine:  sealup keyscan ${name}   then commit ${file}.`,
              ]
            : [
                `Run on your machine:  sealup keyscan ${name}`,
                `It shows the key for you to confirm and writes hostKey into ${file}.`,
                'Commit that line.',
              ]),
        ],
        state: [`sealup did not connect. ${nothing}`],
        slug: 'host-key-missing',
      };
    }
    case 'host-key-not-replaced':
      return explainNotReplaced(problem, ci);
    case 'certificate-not-replaced':
      return explainPinNotReplaced(problem, ci);
    case 'private-key-unreadable':
      return explainKey(problem, target, fileName(configFile), ci);
    case 'empty-source': {
      const state = [`Nothing was changed on ${problem.target}.`];
      if (problem.missing) {
        // A path that is not there may be a file or a folder: the words claim neither.
        const path = problem.folder === '' ? '.' : problem.folder;
        return {
          title: `${path} does not exist: sealup stopped before connecting.`,
          details: [
            `Deploying without it would delete what sealup put at ${shownPath(problem.serverFolder)}.`,
            'Most likely the build failed or wrote its files somewhere else.',
            ci
              ? `Check the build step before sealup: it must make ${path}.`
              : `Run your build, check that it makes ${path}, then deploy again.`,
          ],
          hint: `If it is gone for good, remove its upload: entry${lineOf(problem.place)}.`,
          state,
          slug: 'empty-source',
        };
      }
      const folder = problem.folder === '' ? './' : `${problem.folder}/`;
      return {
        title: `${folder} is empty: sealup stopped before connecting.`,
        details: [
          `An empty folder would delete the site: every file sealup put in ${shownFolder(problem.serverFolder)}.`,
          'Most likely the build failed or wrote its files somewhere else.',
          ci
            ? `Check the build step before sealup: it must fill ${folder}.`
            : `Run your build, check that it fills ${folder}, then deploy again.`,
        ],
        hint: 'To send an empty folder on purpose: allow: [empty-source] on the target.',
        state,
        slug: 'empty-source',
      };
    }
    case 'manifest-inside-target': {
      // R14 (decision 0038): a folder upload: sends files to is one visitors can reach.
      const { serverFolder } = problem;
      const where =
        serverFolder === problem.targetFolder ? 'the target folder' : printable(serverFolder);
      return {
        title: `The manifest folder is inside ${where}: sealup stopped.`,
        details: [
          `${problem.manifestFolder} is in ${serverFolder}, where upload: sends files${lineOf(problem.place)}:`,
          'visitors could download it.',
          ...(problem.loginFolderInside === true
            ? [
                'The login folder is in it, so the default .sealup is too: send that',
                'upload into a folder of its own (to: www), or set manifest: outside it.',
              ]
            : ['Move manifest: outside it; the default is .sealup in the login folder.']),
        ],
        state: [
          `${problem.connected ? '' : 'sealup did not connect. '}Nothing was changed on ${problem.target}.`,
        ],
        slug: 'manifest-inside-target',
      };
    }
    case 'symlink':
      // R16 (spec #41 decision 27): found after login, before any change.
      if (problem.on === 'server') {
        return {
          title: `${printable(problem.path)} is a symlink on the server: sealup stopped.`,
          details: [
            'sealup never writes through a link: files could land outside the target.',
            'Replace the link with a real folder, or exclude what goes into it.',
          ],
          state: [`Nothing was changed on ${problem.target}.`],
          slug: 'symlink',
        };
      }
      return {
        title: `${problem.path} is a symlink: sealup stopped before connecting.`,
        details: [
          'sealup does not follow links: one could send files from outside the project.',
          'Put the real file or folder there, or exclude the link.',
        ],
        state: [`Nothing was changed on ${problem.target}.`],
        slug: 'symlink',
      };
    case 'risky-folder': {
      // R20 (decision 0029): only with the mirror on; `allow: [root-folder]` is the opt-out.
      const { folder, mirror, mirrored } = problem;
      const root = folder === '/';
      const place = root ? "the server's root" : 'the login folder';
      return {
        title: `The target folder ${printable(folder)} is ${place}: sealup stopped${problem.connected ? '' : ' before connecting'}.`,
        details: [
          // The mirror deletes only in the folders it mirrors: name them, unless that is it all.
          ...(mirrored === undefined || mirrored.length === 0
            ? [
                'With the mirror on, sealup deletes every file there that is not in the',
                `build, whatever else the ${root ? 'server' : 'account'} holds.`,
              ]
            : [
                'With the mirror on, sealup deletes every file that is not in the build',
                `from ${listed(mirrored.map(printable))}.`,
                `It mirrors from ${place} only when you allow it.`,
              ]),
          `Deploy into a folder inside it, or ${mirror === undefined ? 'drop --mirror' : `turn the mirror off${lineOf(mirror)}`}.`,
        ],
        hint: 'To mirror it on purpose: allow: [root-folder] on the target.',
        state: [`Nothing was changed on ${problem.target}.`],
        slug: 'risky-folder',
      };
    }
    case 'secret-file-public': {
      const { place } = problem;
      const line = place.line === undefined ? '' : ` (line ${place.line})`;
      if (problem.reason === 'mode-refused') {
        return {
          title: `${target?.server.host ?? 'The server'} cannot set file permissions: sealup stopped.`,
          details: [
            `${place.keyPath}${line} writes ${problem.path} from a secret: it must get`,
            'its file mode before its first byte, and the server refused SITE CHMOD.',
            'Deploy it over sftp:// instead, or remove that entry.',
          ],
          state: [nothing],
          slug: 'secret-file-public',
        };
      }
      return {
        title: 'A file written from a secret would land in a public folder: sealup stopped.',
        details: [
          `${place.keyPath}${line} writes ${problem.path},`,
          `inside ${problem.folder}/, where visitors could download it.`,
          `Write it outside the web folder. If ${problem.folder}/ is not served, add`,
          'allowPublic: true to that entry.',
        ],
        state: [`sealup did not connect. Nothing was changed on ${problem.target}.`],
        slug: 'secret-file-public',
      };
    }
    case 'manifest-unusable':
      return {
        title: manifestTitles[problem.reason],
        details: [
          'It is how sealup knows what it uploaded; a wrong list could make it delete',
          'the wrong files.',
          problem.reason === 'unreadable'
            ? 'Check it in the manifest folder, or delete it to start afresh.'
            : 'Delete it from the manifest folder; the next deploy then starts afresh.',
        ],
        state: [nothing],
        slug: `manifest-${problem.reason}`,
      };
    case 'lock-held':
      return explainLockHeld(problem);
    case 'transport':
      if (problem.run !== undefined && target !== undefined) {
        // Another identity on reconnect: the same command stops the same way until it is pinned.
        const { code } = problem.error;
        const identity = code === 'host-key' ? 'key' : code === 'tls' ? 'certificate' : undefined;
        const rerun =
          identity === undefined
            ? undefined
            : `Once the new ${identity} is pinned, run the same command again to finish.`;
        return {
          ...explainStopped(problem.error, problem.run, target, fileName(configFile), ci),
          state: problem.changed ? partialState(problem.run, target.name, rerun) : [nothing],
          slug: transportSlug(problem.error),
        };
      }
      if (!problem.changed && target !== undefined) {
        const before =
          explainTls(problem.error, target, fileName(configFile), ci) ??
          explainBeforeLogin(problem.error, target, fileName(configFile), ci);
        if (before !== undefined) return before;
      }
      return {
        title: serverSentence(problem.error, target?.server.host),
        details: [],
        state: problem.changed
          ? [
              `${target?.name ?? 'The server'} changed part-way. Run the same command again to finish.`,
            ]
          : [nothing],
        slug: transportSlug(problem.error),
      };
    case 'bad-local-name':
      return {
        title: `${printable(problem.path)} cannot be sent as it is named.`,
        details: [
          localNameReasons[problem.reason],
          'Rename it, or leave it out with exclude in sealup.yml.',
        ],
        state: [`sealup did not connect. Nothing was changed on ${problem.target}.`],
        slug: 'bad-local-name',
      };
    case 'in-the-way':
      return explainInTheWay(problem, target?.name, nothing);
    case 'listing-too-large':
      return explainListing(problem, nothing);
    case 'pull-in-ci':
    case 'no-pull-entries':
    case 'pull-unsafe-name':
    case 'pull-local-path':
    case 'pull-too-large':
    case 'pull-part-way':
      return explainPull(problem, target);
    case 'cancelled':
      return {
        title: problem.picker
          ? 'Stopped: no target was chosen.'
          : 'Stopped: the question was not answered.',
        details: [],
        state: ['Nothing was changed.'],
        slug: 'cancelled',
      };
    case 'interrupted':
      return {
        title: 'Stopped: sealup was interrupted (Ctrl-C).',
        details:
          problem.run === undefined
            ? []
            : ['The transfers in flight finished; no new one started.'],
        state:
          problem.changed && problem.run !== undefined && target !== undefined
            ? partialState(problem.run, target.name)
            : [nothing],
        slug: 'interrupted',
      };
    case 'unexpected': {
      const state =
        problem.changed === undefined
          ? [
              `sealup cannot tell whether ${target?.name ?? 'the server'} changed.`,
              'Run the same command again: it sends only what is missing.',
            ]
          : problem.changed && problem.run !== undefined && target !== undefined
            ? partialState(problem.run, target.name)
            : [nothing];
      return {
        title: 'sealup stopped on an error it did not expect.',
        details: ['Run the same command with --debug to see where, and report it.'],
        state,
        slug: 'internal-error',
      };
    }
  }
}

/** Folders named in a sentence: `a`, `a and b`, `a, b and c`; past three, `a, b, c and 2 more`. */
function listed(names: readonly string[]): string {
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  const last = shown.at(-1) ?? '';
  return shown.length === 1 ? last : `${shown.slice(0, -1).join(', ')} and ${last}`;
}

/** Why a local name cannot be a server path (R10), one sentence each. */
const localNameReasons = {
  'control-character': 'Its name holds a control character (a line break, a tab, …).',
  backslash: 'Its name holds a \\, which a server could read as a folder separator.',
  'drive-letter': 'Its name starts like a Windows drive (C:).',
  other: 'Its name is not a valid path on a server.',
} as const;

const manifestTitles = {
  unreadable: 'sealup cannot read its file list on the server.',
  invalid: "sealup's file list on the server cannot be trusted.",
  'too-large': "sealup's file list on the server is too large to be trusted.",
} as const;

/**
 * A server folder in the config's form as people say it: one in the login folder without its
 * `/~/` (`/~/www` → `www/`, S21), an absolute one as it is; with a trailing `/`.
 */
export function shownFolder(folder: string): string {
  const relative = folder === '/~' ? '~/' : folder.replace(/^\/~\//, '');
  return relative.endsWith('/') ? relative : `${relative}/`;
}

/**
 * A server path in the config's form as people say it, file or folder, no `/` added: one in the
 * login folder without its `/~/` (`/~/www/connect.php` → `www/connect.php`).
 */
export function shownPath(path: string): string {
  return path === '/~' ? '~' : path.replace(/^\/~\//, '');
}
