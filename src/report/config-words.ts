// The sentences about the config file (S12-S15 and every config issue): places and variable
// names only, never a value (R6). Pure (import rules, pure file): no node: import.

import {
  type ConfigExpected,
  type ConfigIssue,
  type ConfigPlace,
  shortestSecret,
} from '../contracts/index.ts';
import { fileName, folderOf, plural } from './format.ts';
import type { Explained } from './problems.ts';

/** `ci`: GitHub's words, where a secret replaces sealup.env (the page's S14 and S15 CI forms). */
export function explainConfig(
  issues: readonly ConfigIssue[],
  chosen: string | undefined,
  ci = false,
): Explained {
  const [first] = issues;
  const file = first === undefined ? 'sealup.yml' : fileName(first.file);
  if (first?.code === 'file-not-found') {
    const searched =
      first.searchedUpTo === undefined
        ? [`sealup looked for ${first.file}`]
        : [
            `sealup looked in ${folderOf(first.file)}`,
            `and each folder above it up to the repo root, ${first.searchedUpTo}`,
          ];
    return {
      title: `There is no ${file} here.`,
      details: [
        ...searched,
        'Run sealup in the folder that holds sealup.yml, or point to it with -c <file>.',
      ],
      state: ['Nothing was changed.'],
      slug: 'config-not-found',
    };
  }
  if (first?.code === 'file-ambiguous') {
    return {
      title: `Two config files in ${folderOf(first.file)}: sealup.yml and sealup.yaml.`,
      details: ['sealup will not guess which one counts. Keep one of them.'],
      state: ['Nothing was changed.'],
      slug: 'config-ambiguous',
    };
  }
  if (first?.code === 'env-file-not-found') {
    return {
      title: `There is no env file at ${first.file}.`,
      details: ['Check the path given to --env-file.'],
      state: ['Nothing was changed.'],
      slug: 'env-file-not-found',
    };
  }
  const target = chosen ?? targetOf(issues);
  const state = [
    `sealup did not connect. Nothing was changed${target === undefined ? '' : ` on ${target}`}.`,
  ];
  if (issues.length === 1 && first?.code === 'variable-not-set') {
    const words = ci ? variableNotPassed(first, target) : variableNotSet(first);
    return { ...words, state, slug: 'variable-not-set' };
  }
  // S15's words are about a password; a file's content, a key or a passphrase written in the
  // file gets the list form.
  if (issues.length === 1 && first?.code === 'secret-in-config' && first.detail === undefined) {
    const words = ci ? secretInRepository(first) : secretInConfig(first);
    return { ...words, state, slug: 'secret-in-config' };
  }
  if (issues.length === 1 && first?.code === 'same-server-path') {
    return {
      title: `Two entries in ${file} send ${first.path ?? 'one path'}.`,
      details: bothLines(first, 'and so does', '.'),
      state,
      slug: 'same-server-path',
    };
  }
  if (issues.length === 1 && first?.code === 'excluded-file') {
    return {
      title: `A single file in ${file} is both uploaded and excluded.`,
      details: bothLines(first, 'and', ' leaves it out.'),
      state,
      slug: 'excluded-file',
    };
  }
  return {
    title: `${file} has ${plural(issues.length, 'problem')}.`,
    details: issues.map((issue) => `${where(issue)}: ${sentence(issue)}`),
    state,
    slug: 'config-invalid',
  };
}

/** S14: the variable, where the config reads it, where sealup looked, and the line to add. */
function variableNotSet(issue: ConfigIssue): Pick<Explained, 'title' | 'details'> {
  const name = issue.variable ?? '';
  const config = fileName(issue.file);
  const line = issue.line === undefined ? config : `${config} line ${issue.line}`;
  const envFile = issue.envFile ?? 'sealup.env';
  const nextToConfig =
    fileName(envFile) === 'sealup.env' && folderOf(envFile) === folderOf(issue.file);
  const envName = nextToConfig ? 'sealup.env' : envFile;
  const fix =
    issue.message ??
    (nextToConfig
      ? `Add this line to sealup.env, next to ${config}:  ${name}=…`
      : `Add this line to ${envFile}:  ${name}=…`);
  return {
    title: `${name} is not set.`,
    details: [
      `${issue.keyPath} (${line}) reads $\{${name}}.`,
      `sealup looked in the environment and in ${envName}.`,
      fix,
    ],
  };
}

/**
 * S14 in GitHub: "empty or not set" (GitHub passes an empty value for a secret that does not
 * exist), and the two steps that bring a secret to sealup's step. A `${VAR:?message}` adds the
 * config's own words last.
 */
function variableNotPassed(
  issue: ConfigIssue,
  target: string | undefined,
): Pick<Explained, 'title' | 'details'> {
  const name = issue.variable ?? '';
  const config = fileName(issue.file);
  const line = issue.line === undefined ? config : `${config} line ${issue.line}`;
  const environment = target === undefined ? 'an environment' : `the ${target} environment`;
  return {
    title: `${name} is empty or not set.`,
    details: [
      `${issue.keyPath} (${line}) reads $\{${name}}.`,
      'In GitHub Actions a secret reaches sealup only through env: on its step.',
      `1. Add the secret ${name} in the repository settings`,
      `   (Secrets and variables › Actions) or in ${environment}.`,
      '2. Pass it under env: of the sealup step:',
      `     ${secretLine(name)}`,
      ...(issue.message === undefined ? [] : [issue.message]),
    ],
  };
}

/** `NAME: ${{ secrets.NAME }}`, the line of a workflow step's `env:` that passes a secret. */
export function secretLine(name: string): string {
  return `${name}: $\{{ secrets.${name} }}`;
}

/**
 * S15 in GitHub: the file is in the repository, so the password is in its history for sure; the
 * fix is a secret passed to the step.
 */
function secretInRepository(issue: ConfigIssue): Pick<Explained, 'title' | 'details'> {
  const config = fileName(issue.file);
  const name = passwordVariable(issue.keyPath);
  return {
    title: `${config} holds a password: ${where(issue)}.`,
    details: [
      'sealup takes passwords only from variables, so they stay out of git.',
      `1. Add the secret ${name} (repository or environment settings) and`,
      '   pass it under env: of the sealup step:',
      `     ${secretLine(name)}`,
      `2. Write this on ${issue.line === undefined ? 'its line' : `line ${issue.line}`} instead:  password: $\{${name}}`,
      '3. This file is in your repository, so the password is in its history:',
      '   change it with your host.',
    ],
  };
}

/** S15: where the password is written, and the three steps that make it safe again. */
function secretInConfig(issue: ConfigIssue): Pick<Explained, 'title' | 'details'> {
  const config = fileName(issue.file);
  const name = passwordVariable(issue.keyPath);
  const move = '1. Move the value to sealup.env (git-ignored):  ';
  const write = `2. Write this on ${issue.line === undefined ? 'its line' : `line ${issue.line}`} instead:`;
  return {
    title: `${config} holds a password: ${where(issue)}.`,
    details: [
      'sealup takes passwords only from variables, so they stay out of git.',
      `${move}${name}=…`,
      `${write.padEnd(move.length)}password: $\{${name}}`,
      `3. If ${config} was ever committed, the password is in your git history:`,
      '   change it with your host.',
    ],
  };
}

/** Stories 43 and 44: the issue's entry, the other line, and why sealup stops. */
function bothLines(issue: ConfigIssue, joiner: string, end: string): string[] {
  const other = issue.other === undefined ? 'another line' : where(issue.other);
  return [
    `${where(issue)} sends it,`,
    `${joiner} ${other}${end}`,
    'sealup will not guess which one wins: change one of the two lines.',
  ];
}

/** Another line of the config, short: `line 9`, or its key path when it has no line. */
function otherLine(issue: ConfigIssue): string {
  const { other } = issue;
  if (other === undefined) return 'another line';
  return other.line === undefined ? other.keyPath : `line ${other.line}`;
}

/** The variable name S15 suggests: SEALUP_PASSWORD for the shorthand, <TARGET>_PASSWORD else. */
export function passwordVariable(keyPath: string): string {
  const target = /^targets\.(.+)\.password$/.exec(keyPath)?.[1];
  if (target === undefined) return 'SEALUP_PASSWORD';
  return `${target.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSWORD`;
}

/** The target every issue is inside (`targets.<name>.…`), if they agree on one. */
export function targetOf(issues: readonly ConfigIssue[]): string | undefined {
  const names = new Set(issues.map((issue) => /^targets\.([^.]+)\./.exec(issue.keyPath)?.[1]));
  const [only] = names;
  return names.size === 1 ? only : undefined;
}

function where(issue: ConfigPlace): string {
  const line = issue.line === undefined ? '' : `line ${issue.line}`;
  if (issue.keyPath === '') return line === '' ? fileName(issue.file) : line;
  return line === '' ? issue.keyPath : `${issue.keyPath} (${line})`;
}

/**
 * What is wrong, in words: places and variable names only, never a value (R6). Short, so that
 * `    <key path> (line N): <sentence>` stays within 80 columns for usual key paths.
 */
export function sentence(issue: ConfigIssue): string {
  const variable = `$\{${issue.variable ?? ''}}`;
  switch (issue.code) {
    case 'file-not-found':
      return 'file not found';
    case 'file-ambiguous':
      return 'sealup.yml and sealup.yaml: keep one';
    case 'env-file-not-found':
      return 'env file not found';
    case 'yaml':
      return `not valid YAML (${issue.detail ?? 'parse error'})`;
    case 'unknown-key':
      return 'unknown key; sealup stops on it';
    case 'missing-key':
      return issue.expected === 'operations' ? expectedWords.operations : 'missing';
    case 'wrong-type':
      return expectedWords[issue.expected ?? 'text'];
    case 'shorthand-with-targets':
      return 'move it into each target';
    case 'no-targets':
      return 'lists no target';
    case 'variable-syntax':
      return `write $\{NAME}, or $$ for one $`;
    case 'server-url':
      return 'write sftp://user@host[:port]/folder';
    case 'host-key':
      return 'write the key line keyscan prints';
    case 'site-url':
      return 'write https://… or http://…';
    case 'bad-path':
      if (issue.detail === 'pull') return 'write a folder inside the folder of sealup.yml';
      return issue.keyPath.endsWith('manifest')
        ? 'write a server folder: no .., no //'
        : 'write a folder: no .., no leading /';
    case 'remote-path':
      if (issue.detail === 'pull') return 'write a path in the target folder: no .., no leading /';
      return issue.detail === 'file'
        ? 'write a file path in the target folder: no .., no leading /'
        : 'write a folder in the target folder: no .., no leading /';
    case 'excluded-file':
      return `${otherLine(issue)} excludes this file`;
    case 'same-server-path':
      return `sends ${issue.path ?? 'a path'}, as ${otherLine(issue)} does`;
    case 'secret-in-config':
      if (issue.detail === 'write') return `holds the file's content; write one $\{NAME}`;
      if (issue.detail === 'privateKey') return `holds a private key; use $\{NAME}`;
      if (issue.detail === 'passphrase') return `holds a passphrase; use $\{NAME}`;
      return `holds a password; use $\{NAME}`;
    case 'login':
      if (issue.detail === 'both') return `password (${otherLine(issue)}) too: keep one`;
      if (issue.detail === 'passphrase-alone')
        return 'only opens a privateKey; add one, or remove it';
      if (issue.detail === 'ftp-key') return `ftp:// logs in with password: $\{NAME} only`;
      return `write password: $\{NAME} or privateKey: $\{NAME}`;
    case 'variable-not-set':
      return `reads ${variable}, which is not set`;
    case 'secret-refused':
      return issue.reason === 'too-short'
        ? `${variable} is under ${shortestSecret} characters`
        : `${variable} has a line break, NUL or edge space`;
    case 'not-available-yet':
      return notYet(issue);
  }
}

function notYet(issue: ConfigIssue): string {
  const { detail } = issue;
  if (detail === undefined) return 'not available yet; sealup stops';
  if (issue.keyPath.endsWith('server'))
    return `${detail}:// is not available yet; use sftp:// or ssh://`;
  return `${detail} is not available yet`;
}

const expectedWords: Readonly<Record<ConfigExpected, string>> = {
  mapping: 'write keys and values, like upload: dist',
  text: 'write text',
  count: 'write a whole number from 1 to 256',
  connections: 'FTP connections: write a whole number from 1 to 16',
  fingerprint: 'write the SHA-256 that sealup keyscan shows, like 71:CA:A9:…',
  duration: 'write a duration like 30s or 2m',
  upload: 'write a folder, or local: server pairs',
  'upload-entry': 'write a server path, {to: path}, or a nonempty list of those destinations',
  targets: 'write target names with their keys',
  target: "write this target's keys",
  'target-name': 'use letters, digits, . _ - only',
  allow: 'write a list, like [empty-source]',
  patterns: 'write a list of patterns, like [logs, *.map]',
  'folder-exclude': 'exclude is only for source folders; remove it from this file mapping',
  operations: 'add at least one upload, write or pull entry',
  write: `write server file: secret pairs, like api/.env: $\{APP_ENV}`,
  'write-entry': 'write one variable, or from: with mode: and allowPublic:',
  mode: "write the mode in quotes, like '0640'",
  'yes-no': 'write true or false',
  pull: 'write server: local pairs, like www/resources: public_html/resources',
};
