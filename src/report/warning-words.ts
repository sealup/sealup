// The words of a run's warnings (spec #41 decision 11): a risk the run takes without stopping,
// said once on every run, right after the target block, in every output form. Today one warning,
// plain FTP (S23): the password and the files travel unencrypted; the fix names the server line,
// and the reason to switch is the measured speed gain (OVH, decision 0007). Pure (import rules,
// pure file): no node: import.

import type { RunWarning, Target } from '../contracts/index.ts';
import type { Annotation } from './annotations.ts';
import { fileName, type Line, lineWord, style } from './format.ts';

/** One warning in words, for each output form. */
interface WarningWords {
  readonly code: RunWarning['code'];
  /** The `!` line. */
  readonly title: string;
  /** The fix, with the config line (`sealup.yml line 4`). */
  readonly fix: string;
  /** Said quietly after the fix. */
  readonly hint: string;
  /** GitHub's annotation, at the config line. */
  readonly annotation: Annotation;
  /** The job summary's `> [!WARNING]` box. */
  readonly box: string;
}

/**
 * The measured first deploy, OVH Perso, the same site over both protocols (CLI page S23, decision
 * 0007's benchmark): the reason the warning gives to switch.
 */
const faster = 'It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.';

/** The words of each warning of a run, in order. */
export function warningWords(
  warnings: readonly RunWarning[],
  target: Target,
  configFile: string,
): WarningWords[] {
  const { server, places } = target;
  const at = `${fileName(configFile)}${lineWord(places.server)}`;
  return warnings.map(({ code }) => ({
    code,
    title: 'Plain FTP: your password and files travel unencrypted.',
    fix: `Most hosts also offer SFTP: write sftp:// in server (${at}).`,
    hint: faster,
    annotation: {
      level: 'warning',
      title: 'Plain FTP',
      message: `Your password and files travel unencrypted to ${server.host}. Most hosts also offer SFTP: write sftp:// in server. ${faster}`,
      file: places.server.file,
      ...(places.server.line === undefined ? {} : { line: places.server.line }),
    },
    box: [
      '> [!WARNING]',
      '> **Plain FTP:** your password and files travel unencrypted.',
      `> Most hosts also offer SFTP: write \`sftp://\` in \`server\` (${at}). ${faster}`,
    ].join('\n'),
  }));
}

/** The warnings under the target block: a yellow `!`, the title, the fix, the dim reason. */
export function warningLines(words: readonly WarningWords[]): Line[] {
  return words.flatMap((warning): Line[] => [
    ['  ', style('!', 'yellow'), ' ', style(warning.title, 'bold')],
    [`    ${warning.fix}`],
    ['    ', style(warning.hint, 'dim')],
  ]);
}
