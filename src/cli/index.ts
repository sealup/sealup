// cli: the `sealup` command (decision 0023).
//
// Decision hidden: argument parsing (util.parseArgs), commands, exit codes, env file choice,
// terminal detection, the form of the output (terminal, GitHub, log), colour on or off.
//
// Interface: main(argv, env, io) returns the exit code. io carries stdout and stderr, the
// terminal flag of each, stdin as a Keyboard (raw-mode keys) and its terminal flag, the current
// folder, the platform, a clock (ms), the transport's `connect`, `scanHostKey` and
// `scanCertificate` (keyscan on `ftps://`, certificate-keyscan.ts), and an
// optional AbortSignal (Ctrl-C). `bin.ts` is the bundle's entry point: it wires the real
// process and the real transport into main(); tests pass their own io (the memory server's
// connect and scan, typed keys).
// createPrompts(keyboard, view, signal) asks the terminal's questions (prompts.ts: the picker,
// yes/no, a hidden answer); askTarget(prompts, question, config) is the target picker.
//
// Invariants: exit codes 0–6 and 130 as in decision 0023. No flag takes a secret, no child
// process, no shell (R5). Nothing prompts when there is no terminal. Human output goes to stderr
// through report (help, `sealup` alone and the version, which scripts read, go to stdout). The form: terminal
// when stderr is one, GitHub when GITHUB_ACTIONS is `true` (and stderr is not a terminal), log
// otherwise (spec #24 decision 27); a log form's first lines come before any other byte, GitHub's
// masks of every secret the config gave first of all (R2). Colour is decided here, not by Node:
// on for a terminal and in GitHub, off in a log, and NO_COLOR (non-empty) or --no-color turn it
// off always; FORCE_COLOR is ignored (ruling 5). A flag or command this version cannot honour
// answers "not available yet" with exit 2, never silently ignored.
//
// Must never know: ssh2, the plan rules, the manifest format.
//
// Status (tickets 04, 07, 08, 09): `deploy [target]`, `-c`, `--env-file`, `-n`, `-v`,
// `--json`, `--no-color`, `--debug`, `-h`, `--version`; sealup.yml is found from the current
// folder up to the repo root unless `-c` names it; `-c` and `--env-file` are relative to the
// current folder. An error sealup did not expect ends with a state line and its docs link like
// any other; only `--debug` shows its stack. A dry run's last line repeats `-c`, `--env-file`,
// `--check-server` and `--mirror` (deploy only, spec #41 decisions 26 and 29; any other command
// refuses them, exit 2). With `--json` every run, a usage error included, ends with the JSON
// object on stdout. Symbols fall back to `√ ×` on a terminal that cannot show Unicode.
// Plan 04 ticket 03: the log and GitHub forms, and `-q` (`-q` with `-v` is exit 2). Ticket 04:
// in GitHub's form a deploy appends its job summary to the file GITHUB_STEP_SUMMARY names (any
// deploy, a usage or config problem included; other commands write none). Ticket 05: `sealup`
// alone (S01, S05: help for the project, never connects), `help [topic]` and
// `<command> --help`, `check [target]` (S06, offline); `help` and `sealup` alone refuse `--json`.
// Ticket 06: questions only when stdin and stderr are both terminals; `deploy` with several
// targets and none named asks with the target picker (S12), Esc or Ctrl-C there is exit 130
// with nothing done. Ticket 11 (#35): `pull [target]` (S24) on a terminal; without one it is
// refused right after reading sealup.yml (S25, exit 2, with GitHub's job summary).
// with nothing done. Ticket 07 (#31): `keyscan [target]` (S04): the key the server shows, saved
// to sealup.yml on a yes at a terminal (config edits the one line), the line to paste without
// one; another key saved is replaced only on a yes, else exit 4. It reads only the target's
// server and never logs in (the scan port, `scanHostKey` in io). Ticket 12 (#36): `init` (S02,
// init.ts asks, the init module writes): on a terminal the server, the key and the password;
// without one `--server` is needed (exit 2 otherwise). `--server` belongs to init alone.
// Ticket 13 (#37): the sam-sync conversion, undocumented: offered by init on a terminal when a
// .deployment.json is there; `--from <file>` (init alone, in no help text) does it anywhere.
// Plan 05 #60: the version comes in io, read by the bundle's entry from the package.json beside
// it (`0.0.0-source` without one); io's release SHA, when the release build put one in, is
// init's workflow pin. Plan 05 T12 (#53): a deploy's lock note names this machine (io's
// `machine`, else the host name) and, in GitHub Actions, the run's page.

import { appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { check } from '../check/index.ts';
import {
  closestTargetName,
  type Env,
  findConfig,
  loadConfig,
  type ResolvedConfig,
  saveHostKey,
} from '../config/index.ts';
import {
  type Connect,
  ExitCode,
  type Problem,
  type Reporter,
  type ScanCertificate,
  type ScanHostKey,
  type Secret,
} from '../contracts/index.ts';
import { deploy, type Runner, stopped } from '../deploy/index.ts';
import { keyscanTarget, notReplaced, scanKey } from '../keyscan/index.ts';
import { pull } from '../pull/index.ts';
import {
  createCheckJsonReporter,
  createInitJsonReporter,
  createJsonReporter,
  createKeyscanJsonReporter,
  createPromptView,
  createPullReporter,
  createSummaryReporter,
  createTerminalReporter,
  type Form,
  type HelpTopic,
  helpTopics,
  type KeyscanJson,
  type Out,
  printCheck,
  printCheckJson,
  printHelp,
  printKeyscan,
  printKeyscanJson,
  printLogStart,
  printNoConfig,
  printProjectHelp,
  printVersion,
  type TerminalOptions,
} from '../report/index.ts';

import { cacheFolder } from './cache-folder.ts';
import { certificateKeyscan } from './certificate-keyscan.ts';
import { initCommand } from './init.ts';
import { askTarget, createPrompts, type Keyboard } from './prompts.ts';
import { readVersion } from './version.ts';

export { createPrompts, type Keyboard, readVersion };

/** The version main() says when io gives none: run from source, not from a bundle. */
const sourceVersion = '0.0.0-source';

interface Stream {
  write(text: string): unknown;
}

/** What main() needs from the process; injected, so tests control every bit of it. */
export interface CliIo {
  readonly stdout: Stream;
  readonly stderr: Stream;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  /** The keyboard: read, in raw mode, only for a question (stdin and stderr both terminals). */
  readonly stdin: Keyboard;
  readonly stdinIsTTY: boolean;
  /** The current folder, absolute. */
  readonly cwd: string;
  /** `process.platform`: whether a terminal can show Unicode depends on it. */
  readonly platform: string;
  /** Milliseconds from any fixed point. */
  readonly clock: () => number;
  /** Opens a session to a target (transport's connect in the real CLI). */
  readonly connect: Connect;
  /** Shows a server's host key, with no login (transport's scanHostKey in the real CLI). */
  readonly scanHostKey: ScanHostKey;
  /**
   * Shows an `ftps://` server's TLS certificate, with no login (transport's scanCertificate in the
   * real CLI; spec #41 decision 12).
   */
  readonly scanCertificate: ScanCertificate;
  readonly signal?: AbortSignal;
  /**
   * Also gets a deploy's `--json` object, with or without `--json`: the GitHub action reads its
   * outputs and its plan file from it (spec #24 decision 34).
   */
  readonly json?: Stream;
  /**
   * A problem found before main() ran (the action's inputs): reported as main() reports its own,
   * for the command in argv, and its exit code returned. Nothing is read or connected.
   */
  readonly refuse?: Problem;
  /**
   * sealup's version: the bundle's entry reads it from the package.json beside the bundle at
   * start-up (spec #41 decision 34). Default `0.0.0-source`.
   */
  readonly version?: string;
  /**
   * The release commit's full SHA, when the release build put it in the bundle: init pins the
   * workflow's sealup step to it (spec #41 decision 38).
   */
  readonly releaseSha?: string;
  /** This machine's name, for the lock's note (decision 0031). Default: `os.hostname()`. */
  readonly machine?: string;
  /**
   * Waits before a deploy's reconnect try (spec #41 decision 20), resolving early on Ctrl-C.
   * Default: a real timer.
   */
  readonly wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

const options = {
  config: { type: 'string', short: 'c' },
  'env-file': { type: 'string' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  'dry-run': { type: 'boolean', short: 'n' },
  // deploy only: the server check for this run (spec #41 decision 26).
  'check-server': { type: 'boolean' },
  // deploy only: the full mirror for this run (decision 0030).
  mirror: { type: 'boolean' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  debug: { type: 'boolean' },
  // init only: the server address, when there is no terminal to ask in (S02).
  server: { type: 'string' },
  // init only, undocumented (0023 §9): a sam-sync config to convert, without a terminal too.
  from: { type: 'string' },
} as const;

/** The flags init cannot honour: refused (exit 2), never ignored. */
const notForInit = ['config', 'env-file', 'dry-run', 'verbose', 'quiet'] as const;

function isHelpTopic(topic: string): topic is HelpTopic {
  return (helpTopics as readonly string[]).includes(topic);
}

/** Runs the `sealup` command line and returns the exit code (decision 0023). */
export async function main(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  const version = io.version ?? sourceVersion;
  const colorOff = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const form: Form = io.stderrIsTTY ? 'terminal' : env.GITHUB_ACTIONS === 'true' ? 'github' : 'log';
  const stderr = (noColorFlag: boolean): Out => ({
    write: (text) => io.stderr.write(text),
    // A terminal by its rules; GitHub's log renders colour, other logs get none (0024 §8).
    color: form !== 'log' && !colorOff && !noColorFlag,
    terminal: io.stderrIsTTY,
    unicode: !io.stderrIsTTY || unicodeTerminal(io.platform, env),
  });
  /** Set once the log's first lines are out: they come before any other byte (0024 §9). */
  let begun = false;
  const begin = (secrets: readonly Secret[] = []): void => {
    if (begun) return;
    begun = true;
    printLogStart(stderr(true), form, { version, ...logWords(argv), secrets });
  };
  const debug = argv.includes('--debug');
  /** The run's reporters: the human one on stderr, and with --json the JSON one on stdout. */
  /** GitHub's job summary file: a deploy in GitHub's form appends its summary (decision 32). */
  const summaryPath = form === 'github' ? env.GITHUB_STEP_SUMMARY : undefined;
  const reporters = (
    out: Out,
    flags: { json: boolean; dryRun: boolean; command: string | null },
    options: TerminalOptions = {},
    config?: ResolvedConfig,
  ): Reporter[] => [
    createTerminalReporter(out, {
      debug,
      form,
      workspace: env.GITHUB_WORKSPACE || io.cwd,
      ...options,
    }),
    ...((flags.command === 'deploy' || flags.command === 'pull') &&
    summaryPath !== undefined &&
    summaryPath !== ''
      ? [
          createSummaryReporter({ append: (text) => appendFileSync(summaryPath, text) }, out, {
            version,
            applyArgs: options.applyArgs ?? [],
            targetNamed: (name) => {
              const found = config?.targets.get(name);
              return found?.ok === true ? found.target : undefined;
            },
          }),
        ]
      : []),
    ...(flags.command === 'deploy' && io.json !== undefined
      ? [
          createJsonReporter(io.json, {
            version,
            command: flags.command,
            dryRun: flags.dryRun,
          }),
        ]
      : []),
    ...(flags.json
      ? [
          flags.command === 'check'
            ? createCheckJsonReporter(io.stdout, version)
            : flags.command === 'keyscan'
              ? createKeyscanJsonReporter(io.stdout, version, () => keyscanFacts)
              : flags.command === 'init'
                ? createInitJsonReporter(io.stdout, version)
                : createJsonReporter(io.stdout, {
                    version,
                    command: flags.command,
                    dryRun: flags.dryRun,
                  }),
        ]
      : []),
  ];
  const fail = (problem: Problem, to: readonly Reporter[]): number => {
    begin();
    const outcome = stopped(problem, 0);
    for (const reporter of to) reporter.on({ type: 'done', outcome });
    return outcome.exitCode;
  };

  /** Set once deploy() runs: from then on sealup cannot tell from here what changed. */
  let deploying = false;
  /** What a keyscan's `--json` object tells, filled as the command goes. */
  let keyscanFacts: KeyscanJson = {};
  try {
    return await run();
  } catch (error) {
    // No stack trace without --debug: an error sealup did not expect still ends with a state
    // line. deploy() catches its own; this is for the steps around it.
    const unexpected = error instanceof Error ? error : new Error(String(error));
    return fail(
      { code: 'unexpected', error: unexpected, changed: deploying ? undefined : false },
      reporters(stderr(argv.includes('--no-color')), unparsedFlags(argv)),
    );
  }

  async function run(): Promise<number> {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(argv);
    } catch (error) {
      const out = stderr(argv.includes('--no-color'));
      return fail(usageProblem(error), reporters(out, unparsedFlags(argv)));
    }
    const { values, positionals, tokens } = parsed;
    const out = stderr(values['no-color'] === true);
    const stdout: Out = {
      write: (text) => io.stdout.write(text),
      color: io.stdoutIsTTY && !colorOff && values['no-color'] !== true,
      terminal: io.stdoutIsTTY,
    };

    if (values.version === true) {
      printVersion(stdout, version);
      return ExitCode.ok;
    }
    const [command, ...rest] = positionals;
    const dryRun = values['dry-run'] === true;
    const flags = { json: values.json === true, dryRun, command: command ?? null };
    const stop = (problem: Problem): number => fail(problem, reporters(out, flags));
    if (io.refuse !== undefined) return stop(io.refuse);
    // `<command> --help` is `sealup help <command>`.
    if (values.help === true && command !== undefined && command !== 'help') return help([command]);
    if (values.help === true || command === 'help') return help(command === undefined ? [] : rest);
    if (command === undefined) return alone();
    if (!['init', 'deploy', 'check', 'keyscan', 'pull'].includes(command)) {
      return stop({ code: 'usage', reason: 'unknown-command', name: command });
    }
    for (const name of ['server', 'from'] as const) {
      if (values[name] !== undefined && command !== 'init') {
        return stop({ code: 'usage', reason: 'unknown-flag', name: `--${name}` });
      }
    }
    if (rest.length > (command === 'init' ? 0 : 1)) {
      return stop({ code: 'usage', reason: 'extra-arguments', name: command, count: rest.length });
    }
    // Only deploy checks the server's copies or mirrors: any other command refuses the flags.
    const deployOnly = tokens.find(
      (token) =>
        token.kind === 'option' && (token.name === 'check-server' || token.name === 'mirror'),
    );
    if (deployOnly?.kind === 'option' && command !== 'deploy') {
      return stop({ code: 'usage', reason: 'flag-not-taken', name: deployOnly.rawName, command });
    }

    if (values.quiet === true && values.verbose === true) {
      return stop({ code: 'usage', reason: 'quiet-and-verbose' });
    }

    if (command === 'init') {
      // init writes in this folder and reads no config or env file; it has no dry run, -v or -q.
      const ignored = tokens.find(
        (token) =>
          token.kind === 'option' && (notForInit as readonly string[]).includes(token.name),
      );
      if (ignored?.kind === 'option') {
        return stop({
          code: 'usage',
          reason: 'flag-not-taken',
          name: ignored.rawName,
          command: 'init',
        });
      }
      return initCommand({
        cwd: io.cwd,
        terminal: io.stdinIsTTY && io.stderrIsTTY,
        keyboard: io.stdin,
        scanHostKey: io.scanHostKey,
        signal: io.signal,
        out,
        form,
        version,
        releaseSha: io.releaseSha,
        server: values.server,
        from: values.from,
        json: flags.json ? io.stdout : undefined,
        stop,
        begin,
      });
    }

    const loaded = await load();
    if (typeof loaded === 'number') return loaded;
    // Without a terminal nothing prompts, and pull is refused (0023 §7, S25): right after
    // reading sealup.yml, before the target's variables or any connection.
    const terminal = io.stdinIsTTY && io.stderrIsTTY;
    if (command === 'pull' && !terminal) {
      const [only] = loaded.targets.size === 1 ? loaded.targets.keys() : [];
      const named = rest[0] ?? only;
      const refused: Problem = {
        code: 'pull-in-ci',
        ...(named === undefined ? {} : { target: named }),
      };
      return fail(refused, reporters(out, flags, {}, loaded));
    }
    if (command === 'check') {
      // Offline (spec #24 decision 14): never connects.
      const found = await check(loaded, rest[0]);
      if ('problem' in found) return stop(found.problem);
      printCheck(out, found, {
        form,
        quiet: values.quiet === true,
        applyArgs: applyArgs(values),
        workspace: env.GITHUB_WORKSPACE || io.cwd,
      });
      if (flags.json) printCheckJson(io.stdout, version, found);
      return found.exitCode;
    }
    if (command === 'keyscan') return keyscanCommand(loaded, rest[0]);

    // Several targets and none named: a person at a terminal picks one (S12); without a
    // terminal deploy stops with the commands to type (exit 2).
    let target = rest[0];
    const picking =
      target === undefined && loaded.targets.size > 1 && io.stdinIsTTY && io.stderrIsTTY;
    if (picking) {
      const prompts = createPrompts(io.stdin, createPromptView(out), io.signal);
      const question = command === 'pull' ? 'Pull from which target?' : 'Deploy to which target?';
      target = await askTarget(prompts, question, loaded);
      if (target === undefined) return stop({ code: 'cancelled', picker: true });
    }
    if (command === 'pull') {
      const pullers = [
        createPullReporter(out, {
          debug,
          verbose: values.verbose === true,
          quiet: values.quiet === true,
          applyArgs: applyArgs(values),
          picked: picking,
        }),
        ...(flags.json ? [createJsonReporter(io.stdout, { version, command, dryRun })] : []),
      ];
      // The server never changes in a pull: an error not expected still says so.
      const outcome = await pull(
        { config: loaded, target, dryRun },
        {
          connect: io.connect,
          emit: (event) => {
            for (const reporter of pullers) reporter.on(event);
          },
          signal: io.signal,
          clock: io.clock,
        },
      );
      return outcome.exitCode;
    }

    const listeners = reporters(
      out,
      flags,
      {
        verbose: values.verbose === true,
        quiet: values.quiet === true,
        applyArgs: applyArgs(values),
        picked: picking,
      },
      loaded,
    );
    deploying = true;
    const outcome = await deploy(
      {
        config: loaded,
        target,
        dryRun,
        checkServer: values['check-server'] === true,
        mirror: values.mirror === true,
        runner: runnerOf(env, io.machine ?? hostname()),
      },
      {
        connect: io.connect,
        emit: (event) => {
          for (const reporter of listeners) reporter.on(event);
        },
        signal: io.signal,
        clock: io.clock,
        cacheFolder: cacheFolder(env, io.platform),
        ...(io.wait === undefined ? {} : { wait: io.wait }),
      },
    );
    return outcome.exitCode;

    /**
     * Finds and reads sealup.yml (or the `-c` file) and its variables. The secrets the file gave
     * are masked before anything is said about it (R2). A problem is printed: its exit code.
     */
    async function load(
      found?: Awaited<ReturnType<typeof findConfig>>,
      options: { readonly logStart: 'always' | 'on-problem' } = { logStart: 'always' },
    ): Promise<ResolvedConfig | number> {
      const file =
        found ??
        (values.config === undefined
          ? await findConfig(io.cwd)
          : { ok: true as const, file: resolve(io.cwd, values.config) });
      if (!file.ok) return stop({ code: 'config', issues: file.issues });
      const envFile = values['env-file'];
      const loaded = await loadConfig(
        file.file,
        env,
        envFile === undefined ? {} : { envFile: resolve(io.cwd, envFile) },
      );
      if (options.logStart === 'always' || !loaded.ok) begin(loaded.secrets);
      if (!loaded.ok) return stop({ code: 'config', issues: loaded.issues });
      return loaded.config;
    }

    /**
     * `sealup` alone (0023 §2, spec #24 decision 12): help for this project, on stdout like
     * `sealup help`, the same in CI (its first line is the version); S01 without a config. It
     * never connects and never writes. A config problem is printed as any command prints it.
     */
    /**
     * `sealup help [topic]` (spec #24 decision 13), on stdout. A command this version does not
     * have answers as the command itself does; another topic gets a did-you-mean, exit 2.
     */
    function help(topics: readonly string[]): number {
      if (flags.json) return stop({ code: 'usage', reason: 'json-not-taken', name: 'help' });
      if (topics.length > 1) {
        return stop({
          code: 'usage',
          reason: 'extra-arguments',
          name: 'help',
          count: topics.length,
        });
      }
      const [topic] = topics;
      if (topic === undefined || isHelpTopic(topic)) {
        printHelp(stdout, topic);
        return ExitCode.ok;
      }
      const suggestion = closestTargetName(topic, helpTopics);
      return stop({
        code: 'usage',
        reason: 'unknown-topic',
        name: topic,
        ...(suggestion === undefined ? {} : { suggestion }),
      });
    }

    /**
     * `sealup keyscan [target]` (S04, spec #24 decision 18): the target block, the key the server
     * shows against the saved one, and on a terminal a yes/no question before the key is saved or
     * replaced (config edits the one line). Without a terminal it never writes: the line to
     * paste, or exit 4 when another key is saved. Never a login, never a password.
     */
    async function keyscanCommand(config: ResolvedConfig, named: string | undefined) {
      keyscanFacts = { configFile: config.file };
      const asking = io.stdinIsTTY && io.stderrIsTTY;
      let prompts: ReturnType<typeof createPrompts> | undefined;
      const ask = () => {
        prompts ??= createPrompts(io.stdin, createPromptView(out), io.signal);
        return prompts;
      };
      let name = named;
      if (name === undefined && config.targets.size > 1 && asking) {
        name = await askTarget(ask(), 'Scan which target?', config);
        if (name === undefined) return stop({ code: 'cancelled', picker: true });
      }
      const chosen = keyscanTarget(config, name);
      if ('problem' in chosen) return stop(chosen.problem);
      const { target } = chosen;
      keyscanFacts = { ...keyscanFacts, target: target.name, server: target.server };
      printKeyscan(out, form, { kind: 'target', name: target.name, server: target.server });
      // Plain FTP has no host key: nothing to scan, nothing to trust (spec #41 decision 12).
      if (target.server.protocol === 'ftp') {
        printKeyscan(out, form, { kind: 'no-key', configFile: config.file, place: target.place });
        if (flags.json) printKeyscanJson(io.stdout, version, keyscanFacts);
        return ExitCode.ok;
      }
      // FTPS shows a certificate instead of a host key (spec #41 decision 12).
      if (target.server.protocol === 'ftps') {
        return certificateKeyscan(
          {
            scan: io.scanCertificate,
            signal: io.signal,
            stdin: io.stdin,
            asking: io.stdinIsTTY && io.stderrIsTTY,
            out,
            form,
            again: [...(config.targets.size > 1 ? [target.name] : []), ...applyArgs(values)],
            record: (certificate, done) => {
              keyscanFacts = { ...keyscanFacts, certificate };
              if (done && flags.json) printKeyscanJson(io.stdout, version, keyscanFacts);
            },
            stop,
          },
          config,
          target,
        );
      }
      const scanned = await scanKey(target, io.scanHostKey, io.signal);
      if ('problem' in scanned) {
        printKeyscan(out, form, { kind: 'not-checked' });
        return stop(scanned.problem);
      }
      const { report } = scanned;
      const done = (state: NonNullable<KeyscanJson['hostKey']>['state']): number => {
        const exitCode = state === 'changed' ? ExitCode.hostKey : ExitCode.ok;
        keyscanFacts = { ...keyscanFacts, hostKey: { key: report.shown, state } };
        if (flags.json) printKeyscanJson(io.stdout, version, keyscanFacts);
        return exitCode;
      };
      // The command to run again: the target named only when the file has several.
      const again = [...(config.targets.size > 1 ? [target.name] : []), ...applyArgs(values)];
      const where = form === 'github' ? 'github' : 'log';
      printKeyscan(out, form, { kind: 'found', report, asking, where, again });
      if (report.state === 'same') return done('already-saved');
      if (!asking) {
        return report.state === 'other' ? stop(notReplaced(report, false)) : done('not-saved');
      }

      const question =
        report.state === 'other'
          ? '  Replace the saved key?'
          : `  Save it to ${basename(config.file)} as hostKey?`;
      const yes = await ask().yesNo(question, false);
      if (yes === undefined) return stop({ code: 'cancelled', picker: false });
      if (!yes) {
        if (report.state === 'other') {
          printKeyscan(out, form, { kind: 'gap' });
          return stop(notReplaced(report, true));
        }
        printKeyscan(out, form, { kind: 'kept', report, reason: 'answered-no', again });
        return done('not-saved');
      }
      const saved = await saveHostKey(config.file, target.name, report.shown.line);
      if (!saved.ok) {
        printKeyscan(out, form, { kind: 'kept', report, reason: 'cannot-edit', again });
        return done(report.state === 'other' ? 'changed' : 'not-saved');
      }
      printKeyscan(out, form, { kind: 'saved', report, line: saved.line });
      return done(report.state === 'other' ? 'replaced' : 'saved');
    }

    async function alone(): Promise<number> {
      if (flags.json) return stop({ code: 'usage', reason: 'json-not-taken' });
      const found = values.config === undefined ? await findConfig(io.cwd) : undefined;
      const [issue] = found === undefined || found.ok ? [] : found.issues;
      if (issue?.code === 'file-not-found') {
        printNoConfig(stdout, { version, repo: issue.searchedUpTo !== undefined });
        return ExitCode.ok;
      }
      const config = await load(found, { logStart: 'on-problem' });
      if (typeof config === 'number') return config;
      const shown = relative(io.cwd, config.file).split(sep).join('/');
      printProjectHelp(stdout, {
        version,
        config: shown === '' ? config.file : shown,
        targets: [...config.targets].map(([name, entry]) => ({
          name,
          site: entry.url ?? entry.host,
          pulls: entry.pulls.map(
            ({ remote, localFromConfig }) =>
              [remote === '' ? '.' : remote, localFromConfig] as const,
          ),
        })),
        args: applyArgs(values),
      });
      return ExitCode.ok;
    }
  }
}

/**
 * Whether a terminal shows ✓ ✗ ━ ─ (decision 0024 §3; the is-unicode-supported rules, from the
 * injected environment): everywhere but the Linux console, and on Windows only in terminals
 * known to (Windows Terminal, VS Code, JetBrains, ConEmu/Cmder, Terminus, Alacritty, xterm) or
 * in CI. The legacy Windows console's font lacks them. Without a terminal the bytes go to a file
 * or a pipe as UTF-8, so the symbols stay.
 */
function unicodeTerminal(platform: string, env: Env): boolean {
  if (platform !== 'win32') return env.TERM !== 'linux';
  return (
    Boolean(env.CI) ||
    Boolean(env.WT_SESSION) ||
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'Terminus-Sublime' ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
  );
}

/**
 * Who runs this deploy, for the lock's note (decision 0031): the machine's name, and in GitHub
 * Actions the run's page, from the variables the runner sets.
 */
function runnerOf(env: Env, machine: string): Runner {
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  const inActions = GITHUB_ACTIONS === 'true' && GITHUB_SERVER_URL !== undefined;
  return inActions && GITHUB_REPOSITORY !== undefined && GITHUB_RUN_ID !== undefined
    ? { machine, ciRun: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` }
    : { machine };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options,
    allowPositionals: true,
    strict: true,
    tokens: true,
  });
}

/** The commands of this version; `help` among them. */
const commands = ['init', 'deploy', 'check', 'keyscan', 'pull', 'help'] as const;
/** The commands that take a target name. */
const targetCommands: readonly string[] = ['deploy', 'check', 'keyscan', 'pull'];

/**
 * The version line's words (spec #24 decision 27, `sealup <version> · <command> [target]`): a
 * command this version has, and the target named for one that takes it. Never a flag, a flag's
 * value or another word typed (a password in `--server`'s URL, R3). When argv does not parse,
 * a flag's value cannot be told from a word, so only a command name is kept.
 */
function logWords(argv: readonly string[]): { command?: string; target?: string } {
  const known = (word: string | undefined) =>
    word !== undefined && (commands as readonly string[]).includes(word) ? word : undefined;
  let positionals: readonly string[];
  try {
    positionals = parse(argv).positionals;
  } catch {
    const command = known(argv.find((word) => !word.startsWith('-')));
    return command === undefined ? {} : { command };
  }
  const [first, ...rest] = positionals;
  const command = known(first);
  if (command === undefined) return {};
  const [target] = rest;
  return targetCommands.includes(command) && rest.length === 1 && target !== undefined
    ? { command, target }
    : { command };
}

/** The flags a dry run's real run needs too: the ones that choose the config and variables. */
function applyArgs(values: ReturnType<typeof parse>['values']): string[] {
  const args: string[] = [];
  if (values.config !== undefined) args.push('-c', values.config);
  if (values['env-file'] !== undefined) args.push('--env-file', values['env-file']);
  if (values['check-server'] === true) args.push('--check-server');
  if (values.mirror === true) args.push('--mirror');
  return args;
}

/** The flags the reporters need, read from argv as typed: for a run that stops before parsing. */
function unparsedFlags(argv: readonly string[]): {
  json: boolean;
  dryRun: boolean;
  command: string | null;
} {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('-n') || argv.includes('--dry-run'),
    command: argv.includes('deploy') ? 'deploy' : argv.includes('pull') ? 'pull' : null,
  };
}

/** parseArgs' error as facts (report words them): the flag it names, never a value. */
function usageProblem(error: unknown): Problem {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : '';
  const named = (flag: string | undefined) => (flag === undefined ? {} : { name: flag });
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return { code: 'usage', reason: 'unknown-flag', ...named(/'([^']+)'/.exec(message)?.[1]) };
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const flag = /'(-\w, --[\w-]+|--[\w-]+)/.exec(message)?.[1];
    return { code: 'usage', reason: 'missing-value', ...named(flag) };
  }
  throw error;
}
