// The words of a run that stopped on the server (S20): what stopped it, the uploads that did not
// arrive, the state of the server and what the rerun does; and of a path the build needs held by
// the other kind (S1). Pure (import rules, pure file): no node: import.

import type { PartialRun, Problem, Target, TransportError } from '../contracts/index.ts';
import { aligned, formatBytes, formatCount, type Line, plural } from './format.ts';
import { loginNotSent } from './login-words.ts';
import type { Explained } from './problems.ts';
import { serverSentence } from './server-words.ts';

/** Files listed under an error at most; the rest are counted. */
const listedFiles = 10;

/**
 * A path the build needs held by the other kind, which sealup may not remove (S1): what stands
 * there, why sealup leaves it, the one fix, and the state. Once the server changed, the rerun
 * finishes only after the path is cleared, so the state line says that, not "run it again".
 */
export function explainInTheWay(
  problem: Extract<Problem, { code: 'in-the-way' }>,
  name: string | undefined,
  nothing: string,
): Explained {
  const needed = problem.found === 'file' ? 'folder' : 'file';
  const why = {
    excluded:
      problem.found === 'file'
        ? 'sealup keeps it: it is excluded in sealup.yml.'
        : 'It holds files sealup keeps: they are excluded in sealup.yml.',
    'not-uploaded':
      problem.found === 'file'
        ? 'sealup did not upload it, and deletes only what it uploaded.'
        : 'It holds files sealup did not upload; it deletes only what it uploaded.',
  }[problem.held];
  const { run } = problem;
  const state =
    problem.changed && run !== undefined
      ? [
          `${name ?? 'The server'} changed part-way: ${formatCount(run.arrived)} of ${plural(run.uploads, 'new file')} arrived.`,
          'Once the path is clear, the same command finishes the job.',
        ]
      : [nothing];
  return {
    title: `${problem.path} is a ${problem.found}; the build needs a ${needed} there.`,
    details: [
      why,
      problem.held === 'excluded'
        ? 'Move the kept files on the server, or rename the path in your build.'
        : 'Move it out of the way on the server, or rename it in your build.',
    ],
    state,
    slug: 'path-in-the-way',
  };
}

/**
 * A run that stopped while executing (S20): what stopped it, the uploads that did not arrive
 * (sizes at column 72), and one fix. SFTP v3 has no quota code: a server whose message says so
 * is `quota`; OpenSSH answers a full disk with a plain "Failure" (`protocol`), so that is worded
 * as the server failing, with a full disk as the most likely cause and the same fix.
 */
export function explainStopped(
  error: TransportError,
  run: PartialRun,
  target: Target,
  file: string,
  ci = false,
): Pick<Explained, 'title' | 'details'> {
  const { host, user, folder } = target.server;
  const phase = run.arrived < run.uploads ? 'Upload stopped' : 'Deploy stopped';
  const refused = run.refused > 0 && run.refused === run.missing.length;
  const list = missingLines(run, refused);
  switch (error.code) {
    case 'quota':
      return {
        title: `${phase}: ${target.name} is out of space.`,
        details: [
          ...(run.refused > 0
            ? [`${host} refused ${plural(run.refused, 'file')}: no space left (quota full).`]
            : [`${host} has no space left (quota full).`]),
          ...list,
          'Free space in your hosting panel (old backups, logs, mailboxes).',
        ],
      };
    case 'protocol':
      return {
        title: `${phase}: ${host} answered with a failure.`,
        details: [
          'It gave no reason. A full disk is the most likely one: OpenSSH says only',
          '"Failure" when the disk or the quota is full.',
          ...list,
          'Check the space in your hosting panel (old backups, logs, mailboxes).',
        ],
      };
    case 'timeout':
      return {
        title: `${phase}: ${host} stopped answering.`,
        details: [
          serverSentence(error, host),
          ...list,
          'If the host is slow at times, raise timeout in sealup.yml (timeout: 2m).',
        ],
      };
    case 'connection-lost':
      return {
        title: `${phase}: the connection to ${host} was lost.`,
        details: ['Most likely the network dropped, or the host closed the connection.', ...list],
      };
    case 'permission':
      return {
        title: `${phase}: ${host} refused a change: permission denied.`,
        details: [`Check that ${user} may write in ${folder} on ${host}.`, ...list],
      };
    // A reconnect (spec #41 decision 20) that met another server identity: no login was sent.
    case 'host-key':
    case 'tls': {
      const certificate = error.code === 'tls';
      const notSent = loginNotSent(target).replace(/\.$/, '');
      return {
        title: `${phase}: ${host} showed another ${certificate ? 'certificate' : 'host key'} on reconnect.`,
        details: [
          `${notSent} there: it may not be your server.`,
          ...list,
          `Ask your host for the ${certificate ? "certificate's SHA-256" : "server's fingerprint"}. If it changed, pin the new one${ci ? ' on' : ':'}`,
          `${ci ? 'your machine: ' : ''}  sealup keyscan ${target.name}   then commit ${file}.`,
        ],
      };
    }
    default:
      return { title: `${phase}: ${serverSentence(error, host)}`, details: list };
  }
}

/**
 * The uploads that did not arrive, path and size (S20: indented 6, sizes at column 72). When
 * every one of them was refused the line above already says so; otherwise a line says what the
 * list is. At most `listedFiles`, then a count of the rest.
 */
function missingLines(run: PartialRun, refused: boolean): (string | Line)[] {
  if (run.missing.length === 0) return [];
  const shown = run.missing.slice(0, listedFiles);
  const rest = run.missing.length - shown.length;
  return [
    ...(refused ? [] : [`These ${plural(run.missing.length, 'file')} did not arrive:`]),
    ...shown.map((file) => aligned(`      ${file.path}`, formatBytes(file.size))),
    ...(rest > 0 ? [`  and ${plural(rest, 'more file')}`] : []),
  ];
}

/**
 * The state line of a run that changed the server and stopped (S20): what it has now, what the
 * same command run again does, and why the site is safe meanwhile.
 */
export function partialState(run: PartialRun, name: string, rerun?: string): string[] {
  // Deletes that made way for a new file or folder (S1) ran before the uploads.
  const keptOld = run.deletes - run.deleted;
  if (run.arrived < run.uploads) {
    const missing = run.uploads - run.arrived;
    const has = `${name} now has ${formatCount(run.arrived)} of ${plural(run.uploads, 'new file')}.`;
    return [
      ...(rerun === undefined ? [`${has} Run the same command again to finish.`] : [has, rerun]),
      run.recorded
        ? `sealup recorded what arrived, so the rerun sends only the ${plural(missing, 'missing file')}.`
        : `sealup could not record what arrived, so the rerun sends all ${plural(run.uploads, 'file')} again.`,
      ...(keptOld > 0
        ? [
            `The ${plural(keptOld, 'old file')} ${keptOld === 1 ? 'was' : 'were'} kept: sealup deletes only after every upload is in.`,
          ]
        : []),
      'Until then the site may serve a mix of old and new files.',
    ];
  }
  const again =
    rerun ??
    (run.recorded
      ? 'Run the same command again to finish.'
      : 'sealup could not record it. Running the same command again is safe.');
  // Files written from a secret come after the uploads, before any delete.
  if (run.written < run.writes) {
    const missing = run.writes - run.written;
    return [
      `${name} has every uploaded file; ${formatCount(missing)} of ${plural(run.writes, 'file')} from secrets ${missing === 1 ? 'was' : 'were'} not written.`,
      rerun ?? 'Run the same command again to finish.',
      ...(keptOld > 0
        ? [
            `The ${plural(keptOld, 'old file')} ${keptOld === 1 ? 'was' : 'were'} kept: sealup deletes only after every file is in.`,
          ]
        : []),
    ];
  }
  if (run.deleted < run.deletes) {
    return [
      `${name} has every new file; ${formatCount(run.deleted)} of ${plural(run.deletes, 'old file')} ${run.deleted === 1 ? 'was' : 'were'} removed.`,
      again,
    ];
  }
  return [
    run.recorded
      ? `${name} has the new build; an emptied folder may be left.`
      : `${name} has the new build.`,
    again,
  ];
}
