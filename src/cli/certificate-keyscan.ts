// `sealup keyscan` on an `ftps://` target (spec #41 decision 12, R7, R8): the certificate the
// server shows and what the normal check says of it. A pin (`tlsFingerprint`) is offered only
// when that check fails, on a terminal and after a yes; without a terminal, the line to paste.
// Another pin than the certificate shown is exit 4 unless it is replaced on a yes. Never a login.

import { basename } from 'node:path';
import { type ResolvedConfig, readKeyVariable, saveTlsFingerprint } from '../config/index.ts';
import {
  ExitCode,
  type Problem,
  revealingValues,
  type ScanCertificate,
} from '../contracts/index.ts';
import { type KeyscanTarget, pinNotReplaced, scanPin } from '../keyscan/index.ts';
import {
  createPromptView,
  type Form,
  type KeyscanJson,
  type Out,
  printCertificateScan,
  printKeyscan,
} from '../report/index.ts';
import { createPrompts, type Keyboard } from './prompts.ts';

/** What the keyscan command hands over: its io, its output, and how it stops. */
export interface CertificateKeyscan {
  readonly scan: ScanCertificate;
  readonly signal: AbortSignal | undefined;
  readonly stdin: Keyboard;
  /** A terminal to ask on (stdin and stderr). */
  readonly asking: boolean;
  readonly out: Out;
  readonly form: Form;
  /** The words after `sealup keyscan` to run it again for this target. */
  readonly again: readonly string[];
  /**
   * Called once the scan is done, before anything is printed of it, with the SHA-256 the server
   * showed (none when the scan failed): GitHub's form masks it with a pin read from a variable.
   */
  readonly scanned: (received: readonly string[]) => void;
  /** Records the certificate's facts for `--json`; prints the object when the run ends well. */
  readonly record: (certificate: NonNullable<KeyscanJson['certificate']>, done: boolean) => void;
  readonly stop: (problem: Problem) => number;
}

export async function certificateKeyscan(
  context: CertificateKeyscan,
  config: ResolvedConfig,
  target: KeyscanTarget,
): Promise<number> {
  const { out, form, again, asking, stop } = context;
  const scanned = await scanPin(target, context.scan, context.signal);
  const shown = 'problem' in scanned ? undefined : scanned.report.shown.certificate.sha256;
  context.scanned(shown === undefined ? [] : revealingValues({ certificate: shown }));
  if ('problem' in scanned) {
    printKeyscan(out, form, { kind: 'not-checked' });
    return stop(scanned.problem);
  }
  const { report } = scanned;
  const done = (state: NonNullable<KeyscanJson['certificate']>['state']): number => {
    context.record({ scan: report.shown, state }, true);
    return ExitCode.ok;
  };
  context.record({ scan: report.shown, state: 'not-saved' }, false);
  const where = form === 'github' ? 'github' : 'log';
  // A pin read from a `${NAME}` is never written over (plan 06 spec #88 decision 8).
  const variable = await readKeyVariable(config.file, target.name, 'tlsFingerprint');
  printCertificateScan(out, form, {
    kind: 'certificate-found',
    report,
    asking,
    where,
    again,
    ...(variable === undefined ? {} : { variable }),
  });
  if (report.state === 'trusted') return done('trusted');
  if (report.state === 'same') return done('already-saved');
  // Nothing to ask: a pin in a variable is never written over, and without a terminal no pin is
  // written at all. Another certificate than the pinned one is exit 4.
  if (variable !== undefined || !asking) {
    return report.state === 'other'
      ? stop(pinNotReplaced(report, false, variable))
      : done('not-saved');
  }
  const question =
    report.state === 'other'
      ? '  Replace the pinned certificate?'
      : `  Pin it in ${basename(config.file)} as tlsFingerprint?`;
  const prompts = createPrompts(context.stdin, createPromptView(out), context.signal);
  const yes = await prompts.yesNo(question, false);
  if (yes === undefined) return stop({ code: 'cancelled', picker: false });
  if (!yes) {
    if (report.state === 'other') {
      printKeyscan(out, form, { kind: 'gap' });
      return stop(pinNotReplaced(report, true));
    }
    printCertificateScan(out, form, {
      kind: 'certificate-kept',
      report,
      reason: 'answered-no',
      again,
    });
    return done('not-saved');
  }
  const sha256 = report.shown.certificate.sha256;
  const saved = await saveTlsFingerprint(config.file, target.name, sha256);
  if (!saved.ok) {
    printCertificateScan(out, form, {
      kind: 'certificate-kept',
      report,
      reason: 'cannot-edit',
      again,
    });
    return report.state === 'other' ? stop(pinNotReplaced(report, true)) : done('not-saved');
  }
  printCertificateScan(out, form, { kind: 'certificate-saved', report, line: saved.line });
  return done(report.state === 'other' ? 'replaced' : 'saved');
}
