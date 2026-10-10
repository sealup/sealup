// The job summary's words for a problem (spec #24 decision 32; the page's summaries of S13-S21):
// a short title for the heading, and the caution box as Markdown paragraphs, the cause first and
// then **Fix:**. GitHub's words, since only GitHub's form writes a summary. A problem the page has
// no summary for gets the log's words. Values sit in code spans; never a secret's value (R6).
// Pure (import rules, pure file): no node: import.

import type {
  ConfigIssue,
  PartialRun,
  Problem,
  Target,
  TransportError,
} from '../contracts/index.ts';
import { passwordVariable, targetOf } from './config-words.ts';
import { fileName, formatCount, plural } from './format.ts';
import { loginNotSent, loginOf, wrongProtocol } from './login-words.ts';
import {
  explain,
  fixLines,
  type Slug,
  serverSentence,
  shownFolder,
  shownPath,
} from './problems.ts';
import { transportSlug } from './server-words.ts';
import { tlsSummary } from './tls-words.ts';

/** A problem in the summary's words. */
export interface SummaryWords {
  /** The heading's words, without the emoji or what changed (S20's own words say that). */
  readonly title: string;
  /** Whether the title already tells what changed: no `: nothing was changed` after it. */
  readonly whole?: boolean;
  /** The caution box: Markdown paragraphs, each of one or more lines. */
  readonly box: readonly string[];
  /** The docs slug the summary links. */
  readonly slug: Slug;
}

/**
 * A code span holding `text` as it is: fenced with more backticks than any run inside it (and a
 * space inside when it starts or ends with one), so a value cannot end it early.
 */
export function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The target a problem found before the `start` event names, if any (ruling 3). */
export function problemTarget(problem: Problem): string | undefined {
  switch (problem.code) {
    case 'config':
      return problem.target ?? targetOf(problem.issues);
    case 'empty-source':
    case 'symlink':
    case 'bad-local-name':
    case 'manifest-inside-target':
    case 'private-key-unreadable':
    case 'pull-in-ci':
    case 'no-pull-entries':
      return problem.target;
    default:
      return undefined;
  }
}

/** The words of a problem; `target` is the Target when the run knows it. */
export function summaryWords(
  problem: Problem,
  target: Target | undefined,
  configFile: string,
): SummaryWords {
  return pageWords(problem, target, fileName(configFile)) ?? logWords(problem, target, configFile);
}

/** The log's words: what happened as the title, then the details, the hint and the state. */
function logWords(problem: Problem, target: Target | undefined, configFile: string): SummaryWords {
  const explained = explain(problem, target, configFile, true);
  // A file list (a Line) is in the summary's own block, not in the box.
  const details = explained.details.filter((detail) => typeof detail === 'string');
  const words = fixLines({ ...explained, details });
  const box = [words.join(' '), explained.state.join(' ')]
    .map((text) => text.replace(/ {2,}/g, ' '))
    .filter((text) => text !== '');
  const stopped = stoppedPartWay(problem, target);
  return {
    title: stopped ?? explained.title.replace(/\.$/, ''),
    ...(stopped === undefined ? {} : { whole: true }),
    box,
    slug: explained.slug,
  };
}

/** S20's heading for a run that changed the server and stopped: how many files arrived. */
function stoppedPartWay(problem: Problem, target: Target | undefined): string | undefined {
  if (!('run' in problem) || problem.run === undefined || target === undefined) return undefined;
  if (problem.changed !== true) return undefined;
  const { arrived, uploads } = problem.run;
  return arrived < uploads
    ? `Stopped part-way: ${formatCount(arrived)} of ${plural(uploads, 'file')} reached ${target.name}`
    : `Stopped part-way: every new file reached ${target.name}`;
}

/** The page's own summary words for a problem; undefined when the page has none. */
function pageWords(
  problem: Problem,
  target: Target | undefined,
  file: string,
): SummaryWords | undefined {
  switch (problem.code) {
    case 'config': {
      const [issue] = problem.issues;
      if (problem.issues.length !== 1 || issue === undefined) return undefined;
      return secretWords(issue, problem.target ?? targetOf(problem.issues));
    }
    case 'unknown-target': {
      const { suggestion } = problem;
      const names = problem.names.map(code).join(', ');
      return {
        title: `No target named ${problem.name}`,
        box: [
          `${code(fileName(problem.configFile))} has no target ${code(problem.name)}. Targets: ${names}.`,
          suggestion === undefined
            ? '**Fix:** set `target:` in the workflow to one of them, or run `sealup deploy` with its name.'
            : `**Fix:** did you mean ${code(suggestion)}? Set ${code(`target: ${suggestion}`)} in the workflow, or run ${code(`sealup deploy ${suggestion}`)}.`,
        ],
        slug: 'unknown-target',
      };
    }
    case 'target-not-named': {
      const names = problem.names.map(code);
      const listed =
        names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
      const [first] = problem.names;
      return {
        title: 'No target named',
        box: [
          `${code(fileName(problem.configFile))} has ${formatCount(problem.names.length)} targets, ${listed}, and this step did not name one. In CI sealup never asks.`,
          "**Fix:** set the action's `target` input:",
          ['```yaml', 'with:', `  target: ${first ?? ''}`, '```'].join('\n'),
          `or run ${problem.names.map((name) => code(`sealup deploy ${name}`)).join(' / ')}.`,
        ],
        slug: 'target-not-named',
      };
    }
    case 'host-key-missing': {
      if (target === undefined) return undefined;
      const owner = target.places.server.keyPath.replace(/\.?server$/, '');
      return {
        title: 'Host key missing',
        box: [
          `${owner === '' ? 'The target' : code(owner)} has no \`hostKey\`, so sealup cannot confirm the server is yours. It checks the server first, so an impostor never receives the password. sealup never trusts a new key in CI.`,
          `**Fix:** on your machine, run ${code(`sealup keyscan ${target.name}`)}, confirm the key, and commit ${code(file)}.`,
        ],
        slug: 'host-key-missing',
      };
    }
    case 'empty-source': {
      const likely = 'Most likely the build failed or wrote its files somewhere else.';
      if (problem.missing) {
        // A path that is not there may be a file or a folder: the words claim neither.
        const path = code(problem.folder === '' ? '.' : problem.folder);
        return {
          title: 'Upload source missing',
          box: [
            `${path} does not exist. Deploying without it would delete what sealup put at ${code(shownPath(problem.serverFolder))}. ${likely}`,
            `**Fix:** check the build step before sealup: it must make ${path}.`,
          ],
          slug: 'empty-source',
        };
      }
      const folder = code(problem.folder === '' ? './' : `${problem.folder}/`);
      return {
        title: 'Empty build folder',
        box: [
          `${folder} is empty. Sending it would delete every file sealup put in ${code(shownFolder(problem.serverFolder))}. ${likely}`,
          `**Fix:** check the build step before sealup: it must fill ${folder}.`,
        ],
        slug: 'empty-source',
      };
    }
    case 'pull-in-ci': {
      const command = `sealup pull${problem.target === undefined ? '' : ` ${problem.target}`}`;
      return {
        title: 'sealup pull does not run in CI',
        box: [
          '`sealup pull` copies server files to the machine it runs on, and a CI runner is thrown away when the job ends, so the files would go with it.',
          `**Fix:** remove \`sealup pull\` from the workflow and run ${code(command)} on your own machine.`,
        ],
        slug: 'pull-in-ci',
      };
    }
    case 'transport':
      if (target === undefined) return undefined;
      if (problem.run !== undefined) return quotaWords(problem.error, problem.run, target);
      return problem.changed ? undefined : beforeLogin(problem.error, target, file);
    default:
      return undefined;
  }
}

/** A password the step did not get (S14), or one written in the file (S15). */
function secretWords(issue: ConfigIssue, target: string | undefined): SummaryWords | undefined {
  const file = fileName(issue.file);
  const at = `${code(issue.keyPath)} (${file}${issue.line === undefined ? '' : ` line ${issue.line}`})`;
  if (issue.code === 'variable-not-set' && issue.variable !== undefined) {
    const name = issue.variable;
    const environment = target === undefined ? 'an environment' : `the ${code(target)} environment`;
    return {
      title: `${name} is not set`,
      box: [
        `${at} reads ${code(`$\{${name}}`)}, and the sealup step did not get it.`,
        `**Fix:** add the secret ${code(name)} (repository settings, or ${environment}), then pass it under \`env:\` of the sealup step:`,
        ['```yaml', `${name}: $\{{ secrets.${name} }}`, '```'].join('\n'),
      ],
      slug: 'variable-not-set',
    };
  }
  // A password written in the file; a file's content, a key or a passphrase gets the log's words.
  if (issue.code === 'secret-in-config' && issue.detail === undefined) {
    const name = passwordVariable(issue.keyPath);
    const where = issue.line === undefined ? `In ${file}` : `On line ${issue.line}`;
    return {
      title: `Password written in ${file}`,
      box: [
        `${at} holds a password instead of a variable. sealup takes passwords only from variables, so they stay out of git.`,
        [
          '**Fix:**',
          `1. Add the secret ${code(name)} and pass it under \`env:\` of the sealup step: ${code(`${name}: $\{{ secrets.${name} }}`)}`,
          `2. ${where} write ${code(`password: $\{${name}}`)}`,
          "3. **Change that password with your host:** it is in this repository's history.",
        ].join('\n'),
      ],
      slug: 'secret-in-config',
    };
  }
  return undefined;
}

/** A server out of space while uploading (S20); other stops part-way get the log's words. */
function quotaWords(
  error: TransportError,
  run: PartialRun,
  target: Target,
): SummaryWords | undefined {
  if (error.code !== 'quota' || run.arrived === run.uploads) return undefined;
  const host = code(target.server.host);
  const keptOld = run.deletes - run.deleted;
  const missing = run.uploads - run.arrived;
  const cause = [
    run.refused > 0
      ? `${host} refused ${plural(run.refused, 'file')}: **no space left (quota full)**.`
      : `${host} has **no space left (quota full)**.`,
    ...(keptOld > 0
      ? [
          `The ${plural(keptOld, 'old file')} ${keptOld === 1 ? 'was' : 'were'} kept: sealup deletes only after every upload is in.`,
        ]
      : []),
    'Until the next run, the site may serve a mix of old and new files.',
  ];
  const rerun = run.recorded
    ? `sealup recorded what arrived, so it sends only the ${plural(missing, 'missing file')}.`
    : `sealup could not record what arrived, so it sends all ${plural(run.uploads, 'file')} again.`;
  return {
    title: stoppedPartWay({ code: 'transport', error, changed: true, run }, target) ?? '',
    whole: true,
    box: [
      cause.join(' '),
      `**Fix:** free space in your hosting panel (old backups, logs, mailboxes), then re-run this job. ${rerun}`,
    ],
    slug: 'quota-full',
  };
}

/** A connection that stopped before login: the host key (S17), the password (S18), the port. */
function beforeLogin(
  error: TransportError,
  target: Target,
  file: string,
): SummaryWords | undefined {
  const { server, places } = target;
  const keyscan = code(`sealup keyscan ${target.name}`);
  const tls = tlsSummary(error, target, file, code);
  if (tls !== undefined) return { ...tls, slug: transportSlug(error) };
  if (error.code === 'host-key' && error.received !== undefined && target.hostKey !== undefined) {
    const line = places.hostKey?.line === undefined ? '' : ` (line ${places.hostKey.line})`;
    return {
      title: 'Host key changed',
      box: [
        `${code(server.host)} sent a host key that is not the one in ${code(file)}${line}. sealup stopped before logging in; ${loginNotSent(target).charAt(0).toLowerCase()}${loginNotSent(target).slice(1)}`,
        'Either your host moved the site to a new server, or someone between the runner and the server is intercepting the connection.',
        `**Fix:** ask your host for the server's fingerprint. If it is the received one, run ${keyscan} on your machine and commit ${code(file)}.`,
      ],
      slug: 'host-key-changed',
    };
  }
  if (error.code === 'auth') {
    const login = loginOf(target);
    const authorized =
      login.kind === 'password'
        ? ''
        : ` Its public key must be in \`~/.ssh/authorized_keys\` for ${code(server.user)}.`;
    return {
      title: 'Login refused',
      box: [
        `${code(server.host)} refused the login for user ${code(server.user)}. sealup does not retry a refused login: hosts block an IP after a few failures.`,
        `**Fix:** check the secret ${code(login.variable)} (used by ${code(login.keyPath)}), then re-run this job.${authorized}`,
      ],
      slug: 'login-refused',
    };
  }
  if (error.reason === 'speaks-ftp') {
    const words = wrongProtocol(target, file);
    return {
      title: `No ${words.what} server on port ${server.port}`,
      box: [
        `${code(`${server.host}:${server.port}`)} answered with an FTP greeting (220), not an SSH one: this port speaks FTP.`,
        `**Fix:** ${words.summaryFix}`,
      ],
      slug: 'wrong-protocol',
    };
  }
  if (error.code === 'unreachable') {
    const line = places.server.line === undefined ? '' : ` line ${places.server.line}`;
    return {
      title: `Cannot reach ${server.host}:${server.port}`,
      box: [
        `sealup could not reach ${code(`${server.host}:${server.port}`)}. ${serverSentence(error, server.host)}`,
        `**Fix:** check the host and port in ${code(places.server.keyPath)} (${file}${line}), and that the server is up.`,
      ],
      slug: 'unreachable',
    };
  }
  return undefined;
}
