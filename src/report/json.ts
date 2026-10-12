// The `--json` reporter (spec #1, "--json object"; decision 0024 §7): one JSON object on stdout
// when the run is done, built from the run's events only, for scripts. Human output still goes
// to stderr through the terminal reporter.
//
// The object, keys in this order: format (1), version, command, target, server (full URL with
// port, never a secret), url, dryRun, status (ok · unchanged · partial · failed · blocked ·
// cancelled), exitCode, uploaded, deleted, unchanged, bytes, durationMs, timings (connect, scan,
// compare, transfer, ms); then `ops` on a dry run (op upload · write · delete · keep, path
// relative to the target folder, reason, size or null; a write's size is always null), `failed`
// (path, code) when operations failed, `error` (code = the docs slug, message, fix, state; lines
// joined with `\n`) when the run failed; then the keys added later, after all of those (0026
// point 4): `written` (files written from a secret); `warnings` (code, message, fix: what the
// run risked without stopping, plain FTP for one; only when there is one, as `failed`);
// `reconnects` (spec #41 decision 20), with `timings.reconnect` (ms, after transfer), only when
// the run lost its connection and tried to reconnect.
// target, server and url are null when unknown. On a dry run the counts are what it would do.
// A pull's object (command `pull`, spec #24 decision 10) has `downloaded` in place of uploaded
// and deleted, and no `written`; its `unchanged` counts the files already here, and its `ops` are
// `download` (path from the folder of sealup.yml, reason new · replace, size).
// Every string passes through secret.redact. `sealup check` has its own object, same format
// (printCheckJson below).

import {
  type CertificateScan,
  type CheckReport,
  type DeployEvent,
  ExitCode,
  type Outcome,
  type Plan,
  type Problem,
  type PullEvent,
  type PullPlan,
  type PullReporter,
  type Reporter,
  type RunWarning,
  type ScannedHostKey,
  type ServerUrl,
  type Target,
} from '../contracts/index.ts';
import { redact } from '../secret/index.ts';
import { changes, formatServer } from './format.ts';
import { explain, fixLines } from './problems.ts';
import { warningWords } from './warning-words.ts';

interface JsonOptions {
  /** sealup's version. */
  readonly version: string;
  /** The command run (`deploy`), or null when there was none. */
  readonly command: string | null;
  /** Whether `--dry-run` was given: what `dryRun` says when the run stops before choosing a target. */
  readonly dryRun: boolean;
}

type JsonStatus = 'ok' | 'unchanged' | 'partial' | 'failed' | 'blocked' | 'cancelled';

interface JsonOp {
  readonly op: 'upload' | 'write' | 'delete' | 'keep' | 'download';
  readonly path: string;
  readonly reason: string;
  readonly size: number | null;
}

/**
 * Writes one JSON object, and its line break, when the run is done: a deploy's, or with the
 * command `pull` a pull's (its events, or a pull that stopped before it began).
 */
export function createJsonReporter(
  out: { readonly write: (text: string) => unknown },
  options: JsonOptions,
): Reporter & PullReporter {
  let target: Target | undefined;
  let configFile = 'sealup.yml';
  let dryRun = options.dryRun;
  let plan: Plan | PullPlan | undefined;
  let warnings: readonly RunWarning[] = [];
  return {
    on(event: DeployEvent | PullEvent) {
      if (event.type === 'start') {
        target = event.target;
        configFile = event.configFile;
        dryRun = event.dryRun;
        warnings = event.warnings;
      } else if (event.type === 'plan') {
        plan = event.plan;
      } else if (event.type === 'done') {
        const object = toJson(event.outcome, {
          ...options,
          dryRun,
          target,
          configFile,
          plan,
          warnings,
        });
        out.write(
          `${JSON.stringify(object, (_, value) => (typeof value === 'string' ? redact(value) : value))}\n`,
        );
      }
    },
  };
}

function toJson(
  outcome: Outcome,
  run: JsonOptions & {
    readonly target: Target | undefined;
    readonly configFile: string;
    readonly plan: Plan | PullPlan | undefined;
    readonly warnings: readonly RunWarning[];
  },
): Record<string, unknown> {
  const { target, plan } = run;
  const warned = target === undefined ? [] : warningWords(run.warnings, target, run.configFile);
  const failed = outcome.failed ?? [];
  const problem =
    outcome.problem === undefined ? undefined : explain(outcome.problem, target, run.configFile);
  return {
    format: 1,
    version: run.version,
    command: run.command,
    target: target?.name ?? null,
    server: target === undefined ? null : formatServer(target.server),
    url: target?.url ?? null,
    dryRun: run.dryRun,
    status: statusOf(outcome),
    exitCode: outcome.exitCode,
    // A pull counts what arrived here; a deploy what it sent and deleted (decision 10).
    ...(run.command === 'pull'
      ? { downloaded: outcome.downloaded ?? 0 }
      : { uploaded: outcome.uploaded, deleted: outcome.deleted }),
    unchanged: outcome.unchanged,
    bytes: outcome.bytes,
    durationMs: outcome.durationMs,
    timings: { ...outcome.timings },
    ...(run.dryRun && plan !== undefined ? { ops: opsOf(plan) } : {}),
    ...(failed.length > 0 ? { failed: failed.map(({ path, code }) => ({ path, code })) } : {}),
    ...(problem === undefined
      ? {}
      : {
          error: errorOf(problem),
        }),
    // Keys added since the first version come after every key it printed (0026 point 4).
    ...(run.command === 'pull' ? {} : { written: outcome.written }),
    // What the run risked without stopping, in the terminal's words; only when there is one.
    ...(warned.length === 0
      ? {}
      : {
          warnings: warned.map((warning) => ({
            code: warning.code,
            message: warning.title,
            fix: [warning.fix, warning.hint].join('\n'),
          })),
        }),
    // How many times the run reconnected (S11); only when it tried to, as `timings.reconnect`.
    ...(outcome.reconnects === undefined ? {} : { reconnects: outcome.reconnects }),
  };
}

/**
 * `sealup check --json` (spec #24 decision 10, format 1): format, version, command (`check`),
 * target (the name given, or null), status (ok · failed · blocked), exitCode, then `targets`
 * (each checked target's name, whether it is ready, and the names of its missing variables), and
 * `error` (as a run's) when the exit code is not 0.
 */
export function printCheckJson(
  out: { readonly write: (text: string) => unknown },
  version: string,
  found: CheckReport | { readonly problem: Problem; readonly exitCode: ExitCode },
): void {
  const report = 'targets' in found ? found : undefined;
  const named = report?.named === true ? report.targets[0] : undefined;
  const deciding =
    report === undefined
      ? { problem: 'problem' in found ? found.problem : undefined, target: undefined }
      : report.exitCode === ExitCode.ok
        ? undefined
        : report.targets[0];
  const { exitCode } = found;
  const problem =
    deciding?.problem === undefined
      ? undefined
      : explain(deciding.problem, deciding.target, report?.configFile ?? 'sealup.yml');
  const object = {
    format: 1,
    version,
    command: 'check',
    target: named?.name ?? null,
    status:
      exitCode === ExitCode.ok ? 'ok' : exitCode === ExitCode.safetyNet ? 'blocked' : 'failed',
    exitCode,
    targets: (report?.targets ?? []).map((target) => ({
      name: target.name,
      ready: target.problem === undefined,
      missing:
        target.problem?.code === 'config'
          ? target.problem.issues.flatMap((issue) =>
              issue.code === 'variable-not-set' && issue.variable !== undefined
                ? [issue.variable]
                : [],
            )
          : [],
    })),
    ...(problem === undefined ? {} : { error: errorOf(problem) }),
  };
  out.write(
    `${JSON.stringify(object, (_, value) => (typeof value === 'string' ? redact(value) : value))}\n`,
  );
}

/**
 * The `--json` object of a check that stopped before checking a target (an unknown target, a
 * usage or file problem): printCheckJson's shape, with no target.
 */
export function createCheckJsonReporter(
  out: { readonly write: (text: string) => unknown },
  version: string,
): Reporter {
  return {
    on(event: DeployEvent) {
      if (event.type !== 'done' || event.outcome.problem === undefined) return;
      const { problem, exitCode } = event.outcome;
      printCheckJson(out, version, { problem, exitCode });
    },
  };
}

/** What a keyscan's `--json` object tells; cli fills it as the command goes. */
export interface KeyscanJson {
  /** The config file, absolute, once read. */
  readonly configFile?: string;
  /** The target scanned, once chosen. */
  readonly target?: string;
  readonly server?: ServerUrl;
  /** The key shown, and what became of it. */
  readonly hostKey?: {
    readonly key: ScannedHostKey;
    readonly state: 'not-saved' | 'saved' | 'already-saved' | 'replaced' | 'changed';
  };
  /**
   * `ftps://` (spec #41 decision 12): the certificate shown, what the normal check says, and what
   * became of the pin (`trusted`: nothing to pin).
   */
  readonly certificate?: {
    readonly scan: CertificateScan;
    readonly state: 'trusted' | 'not-saved' | 'saved' | 'already-saved' | 'replaced' | 'changed';
  };
}

/**
 * `sealup keyscan --json` (spec #24 decision 10, format 1): format, version, command
 * (`keyscan`), target and server (null until chosen), status (ok · failed · cancelled), exitCode,
 * `hostKey` (type, fingerprint, line, state; null when no key was shown), and `error` (as a
 * run's) when the exit code is not 0. A key not replaced gives its key, state `changed`. On
 * `ftps://`, `hostKey` is null and a `certificate` key follows it (subject, issuer, validFrom,
 * validTo, sha256, check, state); a pin not replaced gives the certificate, state `changed`.
 */
export function printKeyscanJson(
  out: { readonly write: (text: string) => unknown },
  version: string,
  facts: KeyscanJson,
  stop?: {
    readonly problem: Problem;
    readonly status: Outcome['status'];
    readonly exitCode: ExitCode;
  },
): void {
  const problem = stop?.problem;
  const changed = problem?.code === 'host-key-not-replaced' ? problem : undefined;
  const hostKey =
    changed === undefined ? facts.hostKey : { key: changed.received, state: 'changed' as const };
  const pin = problem?.code === 'certificate-not-replaced' ? problem : undefined;
  const certificate =
    pin === undefined
      ? facts.certificate
      : {
          scan: { certificate: pin.received, check: facts.certificate?.scan.check ?? 'untrusted' },
          state: 'changed' as const,
        };
  const server = changed?.server ?? pin?.server ?? facts.server;
  const object = {
    format: 1,
    version,
    command: 'keyscan',
    target: changed?.target ?? pin?.target ?? facts.target ?? null,
    server: server === undefined ? null : formatServer(server),
    status: stop?.status ?? 'ok',
    exitCode: stop?.exitCode ?? ExitCode.ok,
    hostKey:
      hostKey === undefined
        ? null
        : {
            type: hostKey.key.type,
            fingerprint: hostKey.key.fingerprint,
            line: hostKey.key.line,
            state: hostKey.state,
          },
    ...(certificate === undefined
      ? {}
      : {
          certificate: {
            ...certificate.scan.certificate,
            check: certificate.scan.check,
            state: certificate.state,
          },
        }),
    ...(problem === undefined
      ? {}
      : { error: errorOf(explain(problem, undefined, facts.configFile ?? 'sealup.yml')) }),
  };
  out.write(
    `${JSON.stringify(object, (_, value) => (typeof value === 'string' ? redact(value) : value))}\n`,
  );
}

/** The `--json` object of a keyscan that stopped on a problem: printKeyscanJson's shape. */
export function createKeyscanJsonReporter(
  out: { readonly write: (text: string) => unknown },
  version: string,
  facts: () => KeyscanJson,
): Reporter {
  return {
    on(event: DeployEvent) {
      if (event.type !== 'done' || event.outcome.problem === undefined) return;
      const { problem, status, exitCode } = event.outcome;
      printKeyscanJson(out, version, facts(), { problem, status, exitCode });
    },
  };
}

/**
 * `sealup init --json` (spec #24 decision 10, format 1): format, version, command (`init`),
 * status (ok · failed · cancelled), exitCode, `files` (the paths written, from the current
 * folder, `/`-separated; a file left as it was is not one), and `error` (as a run's) when the
 * exit code is not 0.
 */
export function printInitJson(
  out: { readonly write: (text: string) => unknown },
  version: string,
  files: readonly string[],
  stop?: {
    readonly problem: Problem;
    readonly status: Outcome['status'];
    readonly exitCode: ExitCode;
  },
): void {
  const object = {
    format: 1,
    version,
    command: 'init',
    status: stop?.status ?? 'ok',
    exitCode: stop?.exitCode ?? ExitCode.ok,
    files,
    ...(stop === undefined
      ? {}
      : { error: errorOf(explain(stop.problem, undefined, 'sealup.yml')) }),
  };
  out.write(
    `${JSON.stringify(object, (_, value) => (typeof value === 'string' ? redact(value) : value))}\n`,
  );
}

/** The `--json` object of an init that stopped on a problem: printInitJson's shape, no file. */
export function createInitJsonReporter(
  out: { readonly write: (text: string) => unknown },
  version: string,
): Reporter {
  return {
    on(event: DeployEvent) {
      if (event.type !== 'done' || event.outcome.problem === undefined) return;
      const { problem, status, exitCode } = event.outcome;
      printInitJson(out, version, [], { problem, status, exitCode });
    },
  };
}

function errorOf(problem: ReturnType<typeof explain>) {
  return {
    code: problem.slug,
    message: problem.title,
    fix: fixLines(problem).join('\n'),
    state: problem.state.join('\n'),
  };
}

/**
 * The spec's status words: Outcome's own (partial and cancelled included, ticket 08), and
 * `blocked` for a run a safety net stopped (exit 6).
 */
function statusOf(outcome: Outcome): JsonStatus {
  if (outcome.status === 'failed' && outcome.exitCode === ExitCode.safetyNet) return 'blocked';
  return outcome.status;
}

/** A dry run's operations, in the order the terminal lists them. */
function opsOf(plan: Plan | PullPlan): JsonOp[] {
  if ('downloads' in plan) {
    return plan.downloads.map(
      (op): JsonOp => ({ op: 'download', path: op.to, reason: op.reason, size: op.size }),
    );
  }
  const { uploads, writes, deletes } = changes(plan);
  return [
    ...uploads.map(
      (op): JsonOp => ({ op: 'upload', path: op.path, reason: op.reason, size: op.size }),
    ),
    // A secret's size is never given (R17).
    ...writes.map((op): JsonOp => ({ op: 'write', path: op.path, reason: op.reason, size: null })),
    ...deletes.map(
      (op): JsonOp => ({ op: 'delete', path: op.path, reason: op.reason, size: null }),
    ),
    ...plan.kept.map(
      (kept): JsonOp => ({ op: 'keep', path: kept.path, reason: kept.reason, size: null }),
    ),
  ];
}
