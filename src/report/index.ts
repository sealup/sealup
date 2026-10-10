// report: the only output sink (R1, decision 0024).
//
// Decision hidden: the output formats (terminal on stderr, JSON on stdout), the three forms of
// the human words (terminal, log, GitHub: 0024 §1, §9), colours, symbols, the progress line and
// the log's 25/50/75 % lines, GitHub's workflow commands (masks, group, annotations) and their
// escaping, number formatting, and redaction of everything printed.
//
// Interface: createTerminalReporter(out, { form, verbose, quiet, applyArgs, debug, workspace,
// picked }) renders a run from its DeployEvents only (stderr), in the form cli chose;
// createPullReporter(out, { verbose, quiet, applyArgs, debug, picked }) renders a pull from its
// PullEvents (S24, on a terminal: pull.ts lays out its lines; its problems in pull-words.ts);
// createPromptView(out) draws the terminal's questions that cli asks (prompt.ts lays out the
// picker, the yes/no and the hidden lines; the view redraws them in place); printLogStart(out,
// form, { version, command, target, secrets }) writes a log form's first lines (GitHub's masks,
// then the version line) before anything else; printNotWritten(out, title, error) is GitHub's
// warning for a file the action could not write for the runner; createJsonReporter(out, { version, command, dryRun })
// writes the `--json` object (stdout) when the run is done (json.ts holds its shape);
// createSummaryReporter(file, out, { version, applyArgs, targetNamed }) appends GitHub's job
// summary to `file` when the run is done (summary.ts lays it out, summary-words.ts words its
// problems; a file it cannot add to is one warning annotation on `out`). The texts that are not
// runs: printHelp(out, topic?) (help.ts), printVersion(out, version), printNoConfig and
// printProjectHelp (`sealup` alone, S01 and S05), printCheck(out, report, options) (S06,
// check.ts) with printCheckJson and createCheckJsonReporter (`check --json`, json.ts),
// printKeyscan(out, form, step) (S04, keyscan.ts), printCertificateScan(out, form, step) on an
// `ftps://` target (certificate-scan.ts), with printKeyscanJson and
// createKeyscanJsonReporter (`keyscan --json`, json.ts), printInit(out, form, step) (S02,
// init.ts) with printInitJson and createInitJsonReporter. `out` is a stream to
// write to, whether to colour, and whether it is a terminal (the progress line). The number
// formatters and `docsSlugs` (every slug linked as `sealup.dev/e/<slug>`, ruling 9) are exported
// for tests and the docs site.
//
// Invariants: everything passes through secret.redact, a whole line at a time, but for one named
// exception: GitHub's `::add-mask::` lines (printLogStart), which must hold each secret's forms
// so GitHub hides them, and come before any other byte (R2). In GitHub's form no line from a
// user value can start a workflow command: one that would is printed between `::stop-commands::`
// and its token (spec #24 decision 31). Colour only when
// the caller says so (cli decides: a terminal or GitHub, and neither NO_COLOR nor --no-color);
// styleText is called with validateStream false, so Node's FORCE_COLOR has no say. Every line
// sealup lays out fits 80 columns with values of the CLI page's size (decision 0024 §2); a value
// (a path, a name, a URL, a command) is never cut or shortened, so a longer one makes a longer
// line that the terminal wraps and copy-paste keeps whole. The one exception is a file list,
// where a long path goes on over more lines after a `/` to keep the sizes in their column.
// Where Unicode is unsafe (cli decides: the legacy Windows console), `√ ×` and a `#`/`-` bar
// replace `✓ ✗ ━ ─`. The formatters are pure: numbers and layout in format.ts, the words of
// problems in problems.ts, the config sentences in config-words.ts, the log forms' own lines and
// GitHub's commands in log.ts, the annotations' words in annotations.ts; the import rules hold
// each to "no node: import".
//
// Must never know: the server, the plan rules, the config file, how a deploy runs.
//
// Status (tickets 04, 06, 07, 09): the terminal reporter for the target block, the plan line
// (uploads, deletes, unchanged), the progress line on a terminal (drawn with CR and ESC[2K, at
// most ten times a second, erased by the next line), the result of a run that ended well
// (delivered, or already up to date; old files removed) and errors (config errors in the
// wording of S12-S15; the safety nets: S21 and the same layout for a symlink, a missing source,
// a manifest folder inside the target and an untrusted manifest); the dry run (DRY RUN label top
// and bottom, every change with "would" verbs, the command that applies it) and `-v` (the file
// list under the plan line, the timing line under the result); the JSON reporter; the fallbacks
// where Unicode is unsafe. Ticket 08: a run that stopped part-way (S20: what did not arrive, the
// state of the server, what the rerun does), Ctrl-C, an error not expected; `--debug` adds its
// stack, nothing else does. Review: a path in the way (S1). Plan 04 ticket 03: the log and
// GitHub forms (version line, 25/50/75 % lines, timing line; masks, the change group, the
// annotations, GitHub's words where its fix differs: S14-S17, S21) and `-q`. Ticket 04: the job
// summary (S07-S10, S13-S21). Ticket 09 (#33): files written from a secret: counted on the plan
// line, listed with their variable (never a size or content) in the dry run, `-v`, the group and
// the summary, delivered in the result line; the public-folder net; `written` and `write` ops in
// `--json`. Ticket 11 (#35): `sealup pull` (S24: the direction, new, to replace and already here,
// the `↓` progress line, the dry run's list, the result), its problems, the refusal in CI (S25:
// annotation and job summary), the pull block of `sealup` alone (S05), `help pull`, and pull's
// `--json` object (`downloaded`, `download` ops).
// Plan 05 ticket 01: split by concern. This file is the interface alone. sink.ts turns lines into
// bytes (redaction, colour, the fallbacks, GitHub's commands); reporters.ts holds the run
// reporters (terminal, pull, job summary); prompt-view.ts the questions' view; screens.ts the
// texts that are not runs.

export { formatBytes, formatCount, formatSeconds } from './format.ts';
export { type HelpTopic, helpTopics } from './help.ts';
export type { InitStep } from './init.ts';
export {
  createCheckJsonReporter,
  createInitJsonReporter,
  createJsonReporter,
  createKeyscanJsonReporter,
  type KeyscanJson,
  printCheckJson,
  printInitJson,
  printKeyscanJson,
} from './json.ts';
export { docsSlugs } from './problems.ts';
export type { PickerOption } from './prompt.ts';
export { createPromptView, type PromptView } from './prompt-view.ts';
export {
  createPullReporter,
  createSummaryReporter,
  createTerminalReporter,
  type TerminalOptions,
} from './reporters.ts';
export {
  printCertificateScan,
  printCheck,
  printHelp,
  printInit,
  printKeyscan,
  printLogStart,
  printNoConfig,
  printNotWritten,
  printProjectHelp,
  printVersion,
} from './screens.ts';
export type { Form, Out } from './sink.ts';
