// GitHub's annotations (0024 §9, spec #24 decision 31): one per problem, and one per config
// issue at its line of the file, so the run page and the pull request show the fix. The same
// words as the log, in one line: a short title, then what to do. Pure (import rules, pure file):
// no node: import; the reporter turns a config file into a path from the workspace.

import type {
  ConfigIssue,
  ConfigPlace,
  PartialRun,
  Problem,
  Target,
  TransportError,
} from '../contracts/index.ts';
import { passwordVariable, secretLine, sentence, targetOf } from './config-words.ts';
import { fileName, formatCount, plural } from './format.ts';
import { explainLockHeld } from './lock-words.ts';
import { loginNotSent, loginOf, wrongProtocol } from './login-words.ts';
import { explain, fixLines, serverSentence, shownFolder, shownPath } from './problems.ts';
import { tlsAnnotation } from './tls-words.ts';

export interface Annotation {
  readonly level: 'error' | 'warning' | 'notice';
  readonly title: string;
  readonly message: string;
  /** The config file (absolute) and the line the annotation points at. */
  readonly file?: string;
  readonly line?: number;
}

/** The annotations of a problem: one, or one per config issue when the file has several. */
export function annotationsOf(
  problem: Problem,
  target: Target | undefined,
  configFile: string,
): Annotation[] {
  const explained = explain(problem, target, configFile, true);
  if (problem.code === 'config' && explained.slug === 'config-invalid') {
    return problem.issues.map(issueAnnotation);
  }
  const own = pageAnnotation(problem, target, fileName(configFile));
  if (own !== undefined) return [own];
  return [
    {
      level: 'error',
      title: explained.title.replace(/\.$/, ''),
      // One line: a file list's column of spaces is one space here.
      message: [...fixLines(explained), ...explained.state].join(' ').replace(/ {2,}/g, ' '),
    },
  ];
}

/**
 * The page's own annotation of a problem (S12-S21 `annotations`): a short title, then the cause
 * and the fix in a few sentences, at the config line it is about. Undefined for a problem the
 * page has none for: it gets the log's words in one line.
 */
function pageAnnotation(
  problem: Problem,
  target: Target | undefined,
  file: string,
): Annotation | undefined {
  switch (problem.code) {
    case 'config':
      return problem.issues.length === 1 && problem.issues[0] !== undefined
        ? secretAnnotation(problem.issues[0], problem.target ?? targetOf(problem.issues))
        : undefined;
    case 'host-key-missing': {
      if (target === undefined) return undefined;
      const owner = target.places.server.keyPath.replace(/\.?server$/, '');
      return {
        level: 'error',
        title: 'Host key missing',
        message: `${owner === '' ? 'The target' : owner} has no hostKey, so sealup cannot confirm the server is yours. Run sealup keyscan ${target.name} on your machine and commit ${file}. sealup never trusts a new key in CI.`,
        ...at(target.places.server),
      };
    }
    case 'unknown-target': {
      const guess = problem.suggestion === undefined ? '' : ` Did you mean ${problem.suggestion}?`;
      return {
        level: 'error',
        title: `Unknown target ${problem.name}`,
        message: `No target named ${problem.name} in ${fileName(problem.configFile)}.${guess} Targets: ${problem.names.join(', ')}. Fix the action's target input or the command.`,
      };
    }
    case 'host-key-not-replaced': {
      const { received, expected } = problem;
      return {
        level: 'error',
        title: 'Host key changed',
        message: `${problem.server.host} sent ${received.fingerprint}; ${file} expects ${expected.fingerprint}. The host moved the site, or someone is intercepting. Ask your host, then run sealup keyscan ${problem.target} on your machine.`,
        ...at(problem.place),
      };
    }
    case 'certificate-not-replaced':
      return {
        level: 'error',
        title: 'TLS certificate changed',
        message: `${problem.server.host} showed SHA-256 ${problem.received.sha256}; ${file} pins ${problem.expected}. The host renewed it, or someone is intercepting. Ask your host, then run sealup keyscan ${problem.target} on your machine.`,
        ...at(problem.place),
      };
    case 'target-not-named': {
      const command = problem.command ?? 'deploy';
      const commands = problem.names.map((name) => `sealup ${command} ${name}`);
      // The action deploys: its input names a deploy's target only.
      const fix = command === 'deploy' ? "Set the action's target input, or run" : 'Run';
      return {
        level: 'error',
        title: 'No target named',
        message: `${fileName(problem.configFile)} has ${formatCount(problem.names.length)} targets (${problem.names.join(', ')}) and none was named. ${fix} ${commands.join(' or ')}.`,
      };
    }
    case 'empty-source': {
      const end = `The build probably failed or wrote elsewhere: check the build step. Nothing was changed on ${problem.target}.`;
      if (problem.missing) {
        // A path that is not there may be a file or a folder: the words claim neither.
        const path = problem.folder === '' ? '.' : problem.folder;
        return {
          level: 'error',
          title: 'Upload source missing',
          message: `${path} does not exist, and deploying without it would delete what sealup put at ${shownPath(problem.serverFolder)} on ${problem.target}. ${end}`,
          ...at(problem.place),
        };
      }
      const folder = problem.folder === '' ? './' : `${problem.folder}/`;
      const site = `${shownFolder(problem.serverFolder)} on ${problem.target}`;
      return {
        level: 'error',
        title: 'Empty build folder',
        message: `${folder} is empty, and sending it would delete the site (${site}). ${end}`,
        ...at(problem.place),
      };
    }
    case 'secret-file-public': {
      const { place, folder } = problem;
      // Over FTP without SITE CHMOD (spec #41 decision 7): the log's words in one line.
      if (problem.reason === 'mode-refused') return undefined;
      return {
        level: 'error',
        title: 'Secret file in a public folder',
        message: `${place.keyPath} writes ${problem.path}, inside ${folder}/, where visitors could download it. Write it outside the web folder, or add allowPublic: true to that entry if ${folder}/ is not served. Nothing was changed on ${problem.target}.`,
        ...at(place),
      };
    }
    case 'lock-held': {
      // The log's words, with a title that fits GitHub's: who holds it is in the message.
      const words = explainLockHeld(problem);
      return {
        level: 'error',
        title: words.title.replace(/: sealup stopped\.$/, ''),
        message: [...fixLines(words), ...words.state].join(' ').replace(/ {2,}/g, ' '),
      };
    }
    case 'pull-in-ci': {
      const command = `sealup pull${problem.target === undefined ? '' : ` ${problem.target}`}`;
      return {
        level: 'error',
        title: 'pull does not run in CI',
        message: `sealup pull copies server files to the machine it runs on, and a CI runner is thrown away when the job ends. Run ${command} on your own machine.`,
      };
    }
    case 'no-terminal':
      return {
        level: 'error',
        title: 'Server address needed',
        message: `sealup init needs --server${problem.deploymentJson ? ' (or --from)' : ''} when there is no terminal to ask in. Nothing was written.`,
      };
    case 'transport':
      if (target === undefined) return undefined;
      if (problem.run !== undefined) return partWay(problem.error, problem.run, target);
      return problem.changed ? undefined : beforeLogin(problem.error, target, file);
    default:
      return undefined;
  }
}

/** A password the step did not get (S14), or one written in the file (S15), at its line. */
function secretAnnotation(issue: ConfigIssue, target: string | undefined): Annotation | undefined {
  const file = fileName(issue.file);
  if (issue.code === 'variable-not-set' && issue.variable !== undefined) {
    const name = issue.variable;
    const environment = target === undefined ? 'environment' : `${target} environment`;
    return {
      level: 'error',
      title: `${name} is not set`,
      message: `${issue.keyPath} reads $\{${name}}, and the sealup step did not get it. Add the secret ${name} (repository or ${environment}), then pass it under env: of the step: ${secretLine(name)}`,
      ...at(issue),
    };
  }
  if (issue.code === 'secret-in-config') {
    return {
      level: 'error',
      title: `Password written in ${file}`,
      message: `${issue.keyPath} must be a variable such as $\{${passwordVariable(issue.keyPath)}}. Move the value to a secret, pass it under env: of the step, and change the password: it is in your git history.`,
      ...at(issue),
    };
  }
  return undefined;
}

/**
 * A server out of space while uploading (S20): what it refused, what the target has now, that
 * the old files stayed, and the fix. Other stops part-way get the log's words.
 */
function partWay(error: TransportError, run: PartialRun, target: Target): Annotation | undefined {
  if (error.code !== 'quota' || run.arrived === run.uploads) return undefined;
  const host = target.server.host;
  const keptOld = run.deletes - run.deleted;
  const refused =
    run.refused > 0
      ? `${host} refused ${formatCount(run.refused)} of ${plural(run.uploads, 'file')}: no space left (quota full).`
      : `${host} has no space left (quota full).`;
  const kept =
    keptOld > 0
      ? `; the ${plural(keptOld, 'old file')} ${keptOld === 1 ? 'was' : 'were'} kept`
      : '';
  return {
    level: 'error',
    title: 'Server out of space',
    message: `${refused} ${target.name} now has ${formatCount(run.arrived)} of ${plural(run.uploads, 'new file')}${kept}. Free space in your hosting panel, then re-run this job to finish.`,
  };
}

/** A connection that stopped before login: the host key (S17), the password (S18). */
function beforeLogin(error: TransportError, target: Target, file: string): Annotation | undefined {
  const { server, places } = target;
  const tls = tlsAnnotation(error, target, file);
  if (tls !== undefined) {
    const place =
      tls.place === 'tlsFingerprint' ? (places.tlsFingerprint ?? places.server) : places.server;
    return { level: 'error', title: tls.title, message: tls.message, ...at(place) };
  }
  if (error.code === 'host-key' && error.received !== undefined && target.hostKey !== undefined) {
    return {
      level: 'error',
      title: 'Host key changed',
      message: `${server.host} sent ${error.received.fingerprint}; ${file} expects ${target.hostKey.fingerprint}. The host moved the site, or someone is intercepting. Ask your host, then run sealup keyscan ${target.name} on your machine. ${loginNotSent(target)}`,
      ...(places.hostKey === undefined ? {} : at(places.hostKey)),
    };
  }
  if (error.reason === 'speaks-ftp') {
    const words = wrongProtocol(target, file);
    return {
      level: 'error',
      title: server.port === 22 ? `FTP server, not ${words.what}` : `Wrong port for ${words.what}`,
      message: `${server.host}:${server.port} answered with an FTP greeting, not SSH. ${words.annotationFix} Nothing was changed on ${target.name}.`,
      ...at(places.server),
    };
  }
  if (error.code === 'unreachable') {
    return {
      level: 'error',
      title: `Cannot reach ${server.host}:${server.port}`,
      message: `${serverSentence(error, server.host)} Check the host and port in ${places.server.keyPath}, and that the server is up. Nothing was changed on ${target.name}.`,
      ...at(places.server),
    };
  }
  if (error.code === 'auth') {
    const login = loginOf(target);
    const check =
      login.kind === 'password'
        ? `Check the password in ${login.variable} (${login.keyPath}).`
        : `Check the key in ${login.variable} (${login.keyPath}): its public key must be in ~/.ssh/authorized_keys for ${server.user}.`;
    return {
      level: 'error',
      title: 'Login refused',
      message: `Login refused by ${server.host} for user ${server.user}. ${check} Not retried: hosts block an IP after a few failures.`,
    };
  }
  return undefined;
}

/** The file and line of a config place, for an annotation. */
function at(place: ConfigPlace): Pick<Annotation, 'file' | 'line'> {
  return { file: place.file, ...(place.line === undefined ? {} : { line: place.line }) };
}

/** A config issue at its place: the key as the title, the fix as a sentence. */
function issueAnnotation(issue: ConfigIssue): Annotation {
  const words = sentence(issue);
  return {
    level: 'error',
    title: issue.keyPath === '' ? fileName(issue.file) : issue.keyPath,
    message: `${words.charAt(0).toUpperCase()}${words.slice(1)}.`,
    ...at(issue),
  };
}
