// The reporters of a run: a deploy's human output on a terminal or in a log (its DeployEvents
// only), a pull's on a terminal (its PullEvents), and GitHub's job summary of a deploy, appended
// when the run is done.

import type {
  DeployEvent,
  HostKeyCheck,
  Plan,
  PullEvent,
  PullPlan,
  PullReporter,
  Reporter,
  RunWarning,
  Target,
} from '../contracts/index.ts';
import { redact } from '../secret/index.ts';
import { annotationsOf } from './annotations.ts';
import {
  dryRunEndLines,
  dryRunPlanLines,
  dryRunStartLines,
  hostKeyLines,
  type Line,
  planLines,
  progressLine,
  resultLines,
  skippedLines,
  targetLines,
  timingLines,
  transferLines,
  verboseLines,
} from './format.ts';
import { lockLines, lockWords } from './lock-words.ts';
import { command, type Group, groupOf, logTimingLines, percentLines } from './log.ts';
import { debugLines, problemLines } from './problems.ts';
import { skipQuestionLine } from './prompt.ts';
import {
  pullDryRunEndLines,
  pullDryRunPlanLines,
  pullDryRunStartLines,
  pullPlanLines,
  pullResultLines,
} from './pull.ts';
import {
  noted,
  type Reconnects,
  reconnectedLines,
  reconnectingLines,
  reconnectNotice,
} from './reconnect-words.ts';
import { printLateMasks } from './screens.ts';
import { hidesServer, identityOf, shownIdentity } from './server-shown.ts';
import {
  annotationCommands,
  eraseLine,
  type Form,
  type Out,
  redrawMs,
  render,
  shellWord,
  writeCommand,
  writeLines,
} from './sink.ts';
import { summaryMarkdown } from './summary.ts';
import { problemTarget } from './summary-words.ts';
import { warningLines, warningWords } from './warning-words.ts';

/** How a terminal reporter words a run, beyond the events. */
export interface TerminalOptions {
  /** `-v`: the file list under the plan line, and the timing line under the result. */
  readonly verbose?: boolean;
  /**
   * `-q`: the target block (R22), every warning and error, and the result line; no plan line,
   * progress, dim extras, file list or timing (spec #24 decision 17).
   */
  readonly quiet?: boolean;
  /**
   * What the dry run's last line tells to run, after `sealup deploy <target>`: the flags of
   * this run that the real one needs too (`-c <file>`). Default none.
   */
  readonly applyArgs?: readonly string[];
  /** `--debug`: after an error, the stack of the error behind it (never without the flag). */
  readonly debug?: boolean;
  /** The form of the words (cli chooses; default `terminal`). */
  readonly form?: Form;
  /**
   * GitHub's form: the folder annotations name files from (`GITHUB_WORKSPACE`, else the current
   * folder). Default: the files as they are.
   */
  readonly workspace?: string;
  /**
   * The target came from the picker (S12): a result ends with the dim command that names it,
   * with `applyArgs`, so the next run skips the question. Not under `-q` (a dim extra).
   */
  readonly picked?: boolean;
}

/** The human output of a run, on a terminal or in a log (stderr). */
export function createTerminalReporter(out: Out, options: TerminalOptions = {}): Reporter {
  const form = options.form ?? 'terminal';
  const quiet = options.quiet === true;
  let target: Target | undefined;
  let configFile = 'sealup.yml';
  let dryRun = false;
  let afterPlan = false;
  let warnings: readonly RunWarning[] = [];
  /** When the progress line was last drawn (run clock, ms); undefined while none is shown. */
  let drawnAt: number | undefined;
  const percents = percentLines();
  const write = (lines: readonly Line[]): void => writeLines(out, lines, form);
  /** The warnings, once the target block is done (S23); GitHub's annotations after them. */
  const warn = (): void => {
    if (target === undefined || warnings.length === 0) return;
    const words = warningWords(warnings, target, configFile);
    write(warningLines(words));
    if (form === 'github') {
      const found = words.map(({ annotation }) => annotation);
      for (const text of annotationCommands(found, options.workspace)) writeCommand(out, text);
    }
    write([[]]);
  };
  /** GitHub's change group, written once the transfer is over (S07, S20). */
  let group: Group | undefined;
  /** The run's first lost connection and the try that came back (S11). */
  let reconnects: Reconnects | undefined;
  /** What the server showed of itself that this log masks already (decision 0045). */
  const masked = new Set<string>();
  /** GitHub's form, a target that hides a part: masks what the server showed, before it shows. */
  const maskShown = (check: HostKeyCheck | undefined): void => {
    if (form !== 'github' || !hidesServer(target)) return;
    const fresh = shownIdentity(check, target).filter((value) => !masked.has(value));
    for (const value of fresh) masked.add(value);
    if (fresh.length > 0) printLateMasks(out, fresh);
  };
  return {
    on(event: DeployEvent) {
      if (event.type === 'progress') {
        const last = event.files === event.totalFiles;
        if (quiet) return;
        if (form !== 'terminal') {
          const line = percents.next(event);
          if (line !== undefined) write([line]);
          return;
        }
        if (!out.terminal) return;
        if (!last && drawnAt !== undefined && event.elapsedMs - drawnAt < redrawMs) return;
        out.write(`${eraseLine}${render(out, progressLine(event))}`);
        drawnAt = event.elapsedMs;
        return;
      }
      // The next line takes the progress line's place (the page's holdUntilNext).
      if (drawnAt !== undefined) {
        out.write(eraseLine);
        drawnAt = undefined;
      }
      switch (event.type) {
        case 'start':
          target = event.target;
          configFile = event.configFile;
          dryRun = event.dryRun;
          warnings = event.warnings;
          if (dryRun) write(dryRunStartLines(event.target));
          write(targetLines(event.target));
          return;
        case 'host-key': {
          maskShown(event);
          const lines = hostKeyLines(event, target, configFile);
          // On ssh://, the transfer line comes next, before the block's blank line (S12).
          const more = event.state === 'verified' && target?.server.protocol === 'ssh';
          write(more ? lines.slice(0, 1) : lines);
          if (!more) warn();
          return;
        }
        case 'transfer':
          write(transferLines(event.via, event.reason));
          warn();
          return;
        // Between the progress lines (S11); under -q, like them, never.
        case 'reconnecting':
          reconnects = noted(reconnects, event);
          if (!quiet) write(reconnectingLines(event, target));
          return;
        case 'reconnected':
          reconnects = noted(reconnects, event);
          if (!quiet) write(reconnectedLines(event));
          return;
        case 'lock': {
          // A warning: printed under -q too.
          const name = target?.name ?? '';
          write(lockLines(event, dryRun, name));
          if (form === 'github') {
            const [title = '', ...rest] = lockWords(event, dryRun, name);
            const heading = dryRun ? 'Target busy' : 'Lock taken over';
            writeCommand(out, command('warning', { title: heading }, [title, ...rest].join(' ')));
          }
          return;
        }
        case 'plan': {
          if (quiet) return;
          if (dryRun) {
            write(dryRunPlanLines(event.plan));
            return;
          }
          const lines = planLines(event.plan);
          // GitHub folds the list in its group instead, at the end of the transfer.
          if (form === 'github') group = groupOf(event.plan);
          else if (options.verbose === true) lines.push(...verboseLines(event.plan));
          lines.push(...skippedLines(event.plan, 'Skipped'));
          afterPlan = lines.length > 0;
          write(lines);
          return;
        }
        case 'done': {
          const { outcome } = event;
          if (group !== undefined) {
            writeCommand(out, group.open);
            write(group.lines);
            writeCommand(out, group.close);
          }
          if (outcome.problem !== undefined) {
            maskShown(identityOf(outcome.problem));
            write(problemLines(outcome.problem, target, configFile, form === 'github'));
            if (options.debug === true) write(debugLines(outcome.problem));
            if (form === 'github') {
              const found = annotationsOf(outcome.problem, target, configFile);
              for (const text of annotationCommands(found, options.workspace)) {
                writeCommand(out, text);
              }
            }
          } else if (target !== undefined && dryRun) {
            const args = [target.name, ...(options.applyArgs ?? [])].map(shellWord);
            const end = dryRunEndLines(`sealup deploy ${args.join(' ')}`);
            // Quiet: right under the target block, which ends with its blank line.
            write(quiet ? end.slice(1) : end);
          } else if (target !== undefined) {
            const result = resultLines(outcome, target, afterPlan);
            // Quiet: the result line alone, without its dim extras or the timing.
            if (quiet) {
              write(result.slice(0, 1));
              return;
            }
            if (options.picked === true) {
              const args = [target.name, ...(options.applyArgs ?? [])].map(shellWord);
              result.push(skipQuestionLine(`sealup deploy ${args.join(' ')}`));
            }
            write(result);
            if (form !== 'terminal') write(logTimingLines(outcome));
            else if (options.verbose === true) write(timingLines(outcome.timings));
            // A flaky host shows on the run's page (S11): after the timing line.
            const count = outcome.reconnects ?? 0;
            if (form === 'github' && count > 0 && reconnects !== undefined && !dryRun) {
              const notice = reconnectNotice(reconnects, count, target);
              for (const text of annotationCommands([notice], options.workspace)) {
                writeCommand(out, text);
              }
            }
          }
          return;
        }
      }
    },
  };
}

/**
 * The human output of a pull (S24), on a terminal: a pull runs only there (0023 §7). The target
 * block, the direction and the plan, the `↓` progress line, the result; a problem as a deploy's.
 */
export function createPullReporter(
  out: Out,
  options: Pick<TerminalOptions, 'verbose' | 'quiet' | 'applyArgs' | 'debug' | 'picked'> = {},
): PullReporter {
  const quiet = options.quiet === true;
  let target: Target | undefined;
  let configFile = 'sealup.yml';
  let dryRun = false;
  let warnings: readonly RunWarning[] = [];
  let plan: PullPlan | undefined;
  let drawnAt: number | undefined;
  const write = (lines: readonly Line[]): void => writeLines(out, lines);
  const command = (): string =>
    `sealup pull ${[target?.name ?? '', ...(options.applyArgs ?? [])].map(shellWord).join(' ')}`;
  return {
    on(event: PullEvent) {
      if (event.type === 'progress') {
        if (quiet || !out.terminal) return;
        const last = event.files === event.totalFiles;
        if (!last && drawnAt !== undefined && event.elapsedMs - drawnAt < redrawMs) return;
        out.write(`${eraseLine}${render(out, progressLine(event, '↓'))}`);
        drawnAt = event.elapsedMs;
        return;
      }
      // The next line takes the progress line's place.
      if (drawnAt !== undefined) {
        out.write(eraseLine);
        drawnAt = undefined;
      }
      switch (event.type) {
        case 'start':
          ({ target, configFile, dryRun, warnings } = event);
          if (dryRun) write(pullDryRunStartLines(event.target));
          write(targetLines(event.target));
          return;
        case 'host-key':
          write(hostKeyLines(event, target, configFile));
          // A pull runs on a terminal only (0023 §7): the warnings' lines, no annotation.
          if (target !== undefined && warnings.length > 0) {
            write([...warningLines(warningWords(warnings, target, configFile)), []]);
          }
          return;
        case 'plan':
          plan = event.plan;
          if (quiet) return;
          write(dryRun ? pullDryRunPlanLines(plan) : pullPlanLines(plan, options.verbose === true));
          return;
        case 'done': {
          const { outcome } = event;
          if (outcome.problem !== undefined) {
            write(problemLines(outcome.problem, target, configFile));
            if (options.debug === true) write(debugLines(outcome.problem));
          } else if (target !== undefined && dryRun) {
            const end = pullDryRunEndLines(command());
            write(quiet ? end.slice(1) : end);
          } else if (target !== undefined) {
            const result = pullResultLines(outcome, target, plan);
            if (quiet) {
              write(result.slice(0, 1));
              return;
            }
            if (options.picked === true) result.push(skipQuestionLine(command()));
            write(result);
            if (options.verbose === true) write(timingLines(outcome.timings));
          }
          return;
        }
      }
    },
  };
}

/** Where the job summary goes: the file GITHUB_STEP_SUMMARY names (cli opens it). */
export interface SummaryFile {
  /** Adds the text at the end of the file; throws when it cannot. */
  readonly append: (text: string) => void;
}

/** What the job summary needs beyond the events. */
export interface SummaryOptions {
  /** sealup's version, in the summary's last line. */
  readonly version: string;
  /** As the terminal reporter's: the flags a dry run's real run needs too. */
  readonly applyArgs?: readonly string[];
  /**
   * A target of the loaded config by name, for a problem found before the `start` event that
   * names one (S21): the summary still shows the target table (R22).
   */
  readonly targetNamed?: (name: string) => Target | undefined;
}

/**
 * The GitHub job summary of a run (spec #24 decision 32): appended once, when the run is done,
 * redacted like every line. A file sealup cannot add to gets one warning annotation on `out`
 * (GitHub's form) and changes nothing else: the run's exit code stays its own.
 */
export function createSummaryReporter(
  file: SummaryFile,
  out: Out,
  options: SummaryOptions,
): Reporter {
  let target: Target | undefined;
  let configFile = 'sealup.yml';
  let dryRun = false;
  let hostKey: HostKeyCheck | undefined;
  let lock: Extract<DeployEvent, { type: 'lock' }> | undefined;
  let plan: Plan | undefined;
  let reconnected: Reconnects | undefined;
  let connections: number | undefined;
  let warnings: readonly RunWarning[] = [];
  let written = false;
  return {
    on(event: DeployEvent) {
      if (event.type === 'start') {
        target = event.target;
        configFile = event.configFile;
        dryRun = event.dryRun;
        warnings = event.warnings;
      } else if (event.type === 'host-key') {
        hostKey = event;
      } else if (event.type === 'pool') {
        connections = event.connections;
      } else if (event.type === 'lock') {
        lock = event;
      } else if (event.type === 'plan') {
        plan = event.plan;
      } else if (event.type === 'reconnecting' || event.type === 'reconnected') {
        reconnected = noted(reconnected, event);
      } else if (event.type === 'done' && !written) {
        written = true;
        const { outcome } = event;
        const named = outcome.problem === undefined ? undefined : problemTarget(outcome.problem);
        const known = target ?? (named === undefined ? undefined : options.targetNamed?.(named));
        const name = known?.name ?? named ?? '';
        const apply = `sealup deploy ${[name, ...(options.applyArgs ?? [])].map(shellWord).join(' ')}`;
        const text = summaryMarkdown({
          version: options.version,
          target: known,
          targetName: named,
          configFile,
          dryRun,
          hostKey,
          ...(lock === undefined ? {} : { lock }),
          ...(reconnected === undefined ? {} : { reconnected }),
          ...(connections === undefined ? {} : { connections }),
          plan,
          warnings,
          outcome,
          apply,
        });
        try {
          file.append(text.split('\n').map(redact).join('\n'));
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          const why = typeof code === 'string' ? ` (${code})` : '';
          const message = `sealup could not add to the file GITHUB_STEP_SUMMARY names${why}. The log above has the whole run.`;
          writeCommand(out, command('warning', { title: 'Job summary not written' }, message));
        }
      }
    },
  };
}
