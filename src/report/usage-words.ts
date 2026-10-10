// The words of a command line sealup cannot run (the `usage` Problem): one sentence from the
// facts cli gives, and what to do about it. Pure (import rules, pure file): no node: import.

import type { Problem } from '../contracts/index.ts';
import { helpTopics } from './help.ts';

/** A command line sealup cannot run, in one sentence (cli gives the facts). */
export function usageTitle(problem: Extract<Problem, { code: 'usage' }>): string {
  const { name } = problem;
  switch (problem.reason) {
    case 'no-command':
      return 'Name a command: sealup deploy [target].';
    case 'unknown-command':
      return `Unknown command ${name ?? ''}.`;
    case 'extra-arguments': {
      const command = name ?? 'deploy';
      if (command === 'init') return 'init takes no target name: it sets up this folder.';
      const one = command === 'help' ? 'topic' : 'target name';
      return `${command} takes one ${one}, not ${problem.count ?? 0}.`;
    }
    case 'unknown-flag':
      return name === undefined ? 'Unknown flag.' : `Unknown flag ${name}.`;
    case 'missing-value':
      return name === undefined ? 'A flag needs a value.' : `${name} needs a value.`;
    case 'quiet-and-verbose':
      return '-q and -v cannot be used together.';
    case 'json-not-taken':
      return `sealup${name === undefined ? ' alone' : ` ${name}`} prints text only: --json is not taken.`;
    case 'unknown-topic':
      return `No help topic named ${name ?? ''}.`;
    case 'outside-workspace':
      return `working-directory ${name ?? ''} is outside the workspace.`;
    case 'no-workspace':
      return 'GITHUB_WORKSPACE is not set: the action runs in GitHub Actions only.';
    case 'not-true-or-false':
      return `${name ?? ''} takes true or false.`;
    case 'bad-server-address':
      return `The address given to ${name ?? '--server'} is not one sealup can use.`;
    case 'not-sam-sync':
      return `sealup cannot read ${name ?? 'the file'} as a sam-sync config.`;
    case 'from-and-server':
      return '--from and --server cannot be used together.';
    case 'flag-not-taken':
      return `${problem.command ?? 'This command'} does not take ${name ?? 'this flag'}.`;
  }
}

/** What to do about a command line sealup cannot run (the action's inputs have their own). */
export function usageDetails(problem: Extract<Problem, { code: 'usage' }>): string[] {
  switch (problem.reason) {
    case 'unknown-topic':
      return [
        ...(problem.suggestion === undefined
          ? []
          : [`Did you mean ${problem.suggestion}?  sealup help ${problem.suggestion}`]),
        `Topics: ${helpTopics.join(', ')}.`,
      ];
    case 'outside-workspace':
      return ['Name a folder inside GITHUB_WORKSPACE, the checkout, relative to it.'];
    case 'no-workspace':
      return ['From a terminal or another CI, run sealup deploy instead.'];
    case 'not-true-or-false':
      return [`Write ${problem.name ?? ''}: true, or leave it out.`];
    case 'bad-server-address':
      return [
        'Write it as sftp://user@host/folder (a port goes after the host: host:2222).',
        'A password never goes in it: sealup reads it from SEALUP_PASSWORD.',
      ];
    case 'not-sam-sync':
      return ['It must be JSON with host and user, and up and down as sam-sync writes them.'];
    case 'from-and-server':
      return ['--from converts a sam-sync config; --server starts from an address.'];
    case 'flag-not-taken':
      return problem.command === 'init'
        ? ['init sets up sealup.yml in this folder: run it in the project folder, without it.']
        : ['Run sealup --help for the commands and flags that work.'];
    default:
      return ['Run sealup --help for the commands and flags that work.'];
  }
}
