// The help screens (`sealup help [topic]`, spec #24 decision 13): the CLI page's reference
// screens (`help`, `help-deploy`, `help-config`, `help-exit-codes`), minus what this version
// cannot honour, and the same layout for the commands the page has no screen for. A feature that
// comes back adds its line here (its golden is test/integration/goldens/help-screens.test.ts).
// Pure (import rules, pure file): no node: import.
//
// The sam-sync conversion is never in any help text (0023 §9): `help init` names neither it nor
// its flag.

import type { Line } from './format.ts';

/** The topics `sealup help` explains, in the order its error lists them. */
export const helpTopics = [
  'init',
  'deploy',
  'pull',
  'keyscan',
  'check',
  'help',
  'config',
  'exit-codes',
] as const;

export type HelpTopic = (typeof helpTopics)[number];

const heading = (text: string, rest = ''): Line => [
  { text, style: 'bold' },
  ...(rest ? [rest] : []),
];
const dim = (text: string): Line => ['  ', { text, style: 'dim' }];
const plain = (...lines: string[]): Line[] => lines.map((line) => [line]);

/** `sealup help` and `sealup --help`. */
const overview: readonly Line[] = [
  ...plain(
    'Deploy your build to shared hosting over SFTP, SSH or FTP.',
    'Only changed files travel.',
  ),
  [],
  heading('USAGE'),
  ...plain('  sealup <command> [target] [flags]'),
  [],
  heading('COMMANDS'),
  ...plain(
    '  init        Write sealup.yml, sealup.env and a GitHub workflow',
    '  deploy      Send changes to a target',
    '  pull        Copy server files (uploads) to this machine',
    "  keyscan     Show the server's host key and save it to sealup.yml",
    '  check       Check sealup.yml and its variables, offline',
    '  help        Commands, config keys, exit codes',
  ),
  [],
  heading('FLAGS'),
  ...plain(
    '  -c, --config <file>     Use this config file (default: sealup.yml)',
    '      --env-file <file>   Read variables from this file (default: sealup.env)',
    '  -n, --dry-run           Show every change, change nothing',
    '      --json              Print one JSON object on stdout',
    '  -v, --verbose           Show the file list and timings',
    '  -q, --quiet             Show the result line only',
    '      --no-color          No colour (NO_COLOR works too)',
    '      --debug             Show where an unexpected error happened',
    '  -h, --help              Show help for a command',
    '      --version           Show the version',
  ),
  [],
  heading('EXAMPLES'),
  ...plain('  $ sealup init', '  $ sealup deploy -n', '  $ sealup deploy production'),
  [],
  heading('LEARN MORE'),
  ...plain(
    '  sealup                    Help for this project (reads sealup.yml)',
    '  sealup help <command>     Details for one command',
    '  sealup help config        The keys of sealup.yml',
    '  sealup help exit-codes    What each exit code means',
  ),
  dim('https://sealup.dev'),
];

/** Not on the page: S02's flow, decisions 19-21 (#36). */
const init: readonly Line[] = [
  ...plain(
    'Set up this project: find the build folder and the build command, ask for',
    "the server address and check the server's key, keep the password in",
    'sealup.env (git-ignored), and write sealup.yml and a GitHub workflow.',
  ),
  [],
  heading('USAGE'),
  ...plain('  sealup init [flags]'),
  [],
  heading('ON A TERMINAL'),
  ...plain(
    "  It asks for the server address, shows the server's host key and saves it",
    '  on a yes, then asks for the password (hidden).',
  ),
  [],
  heading('WITHOUT A TERMINAL'),
  ...plain(
    '  --server is needed. sealup.yml gets a placeholder for the host key (run',
    '  sealup keyscan on your computer), and no sealup.env is written.',
  ),
  [],
  heading('FLAGS'),
  ...plain(
    '      --server <url>        sftp|ssh|ftps|ftp://user@host[:port]/folder',
    '',
    '  Global flags: --json, --no-color (sealup --help)',
  ),
  [],
  heading('NEVER OVERWRITES'),
  ...plain(
    '  An existing sealup.yml stops it (exit 2). An existing workflow is left as',
    '  it is; an existing sealup.env only gets SEALUP_PASSWORD when it lacks it.',
  ),
  [],
  heading('EXAMPLES'),
  ...plain(
    '  $ sealup init',
    '  $ sealup init --server sftp://deploy@ssh.example.com/home/site/www',
  ),
  [],
  heading('LEARN MORE'),
  ...plain('  sealup help config        The keys of sealup.yml'),
  dim('https://sealup.dev/init'),
];

const deploy: readonly Line[] = [
  ...plain(
    'Send the changes in your build to a target. New and changed files go up.',
    'Files that sealup uploaded before and that are gone from your build are',
    'deleted. Everything else on the server is left alone.',
  ),
  [],
  heading('USAGE'),
  ...plain('  sealup deploy [target] [flags]'),
  [],
  heading('TARGET'),
  ...plain(
    '  One target in sealup.yml: no name needed.',
    '  Several targets: name one. Without a name, a terminal shows a picker',
    '  and CI stops with exit 2, listing the names.',
  ),
  [],
  heading('FLAGS'),
  ...plain(
    '  -n, --dry-run             Show every change, change nothing',
    '      --mirror              Also delete server files sealup did not upload',
    '                            (minus excludes). Slower: lists the whole server',
    '      --check-server        Also put back files changed on the server',
    '',
    '  Global flags: -c, --env-file, --json, -v, -q, --no-color (sealup --help)',
  ),
  [],
  heading('SAFETY'),
  ...plain(
    '  There is no confirmation: the dry run is the review step.',
    '  sealup stops before changing anything on an empty build folder, a risky',
    '  target folder, a symlink, or a secret file in a public folder. Opt-outs',
    '  in sealup.yml: allow: for all but the secret file, allowPublic: for it.',
  ),
  [],
  heading('EXAMPLES'),
  ...plain(
    '  $ sealup deploy -n                 # see what would change',
    '  $ sealup deploy                    # the only target',
    '  $ sealup deploy staging            # one of several targets',
    '  $ sealup deploy production --json  # one JSON object on stdout',
  ),
  [],
  heading('LEARN MORE'),
  ...plain('  sealup help exit-codes    Did the server change? The exit code says.'),
  dim('https://sealup.dev/deploy'),
];

/** Not on the page: S24 and S25's rules (spec #24 decision 25), in the layout of `deploy`. */
const pull: readonly Line[] = [
  ...plain(
    "Copy server files (the users' uploads) to this machine. New files come down,",
    "and a local file of another size or date is replaced by the server's copy.",
    'Local files are never deleted, and nothing is written outside the folder of',
    'sealup.yml.',
  ),
  [],
  heading('USAGE'),
  ...plain('  sealup pull [target] [flags]'),
  [],
  heading('TARGET'),
  ...plain(
    '  One target in sealup.yml: no name needed.',
    '  Several targets: name one. Without a name, a terminal shows a picker.',
  ),
  [],
  heading('FLAGS'),
  ...plain(
    '  -n, --dry-run             List every file to download, change nothing',
    '',
    '  Global flags: -c, --env-file, --json, -v, -q, --no-color (sealup --help)',
  ),
  [],
  heading('SAFETY'),
  ...plain(
    '  On your own machine only: without a terminal (CI) it stops with exit 2.',
    '  It stops before writing anything on a server name that Windows or a path',
    '  cannot hold, a link or junction on the local path, or a listing too large.',
    '  Links on the server are skipped, never followed.',
  ),
  [],
  heading('EXAMPLES'),
  ...plain(
    '  $ sealup pull -n                   # see what would come down',
    '  $ sealup pull production           # one of several targets',
  ),
  [],
  heading('LEARN MORE'),
  ...plain('  sealup help config        The pull: key of sealup.yml'),
  dim('https://sealup.dev/pull'),
];

/** Not on the page: S04's states, decision 18 (#31). */
const keyscan: readonly Line[] = [
  ...plain(
    "Show the server's host key and save it to sealup.yml as hostKey, once you",
    "have compared its fingerprint with your host's. sealup checks this key",
    'before it sends your password. keyscan never logs in: it reads no password.',
  ),
  [],
  heading('USAGE'),
  ...plain('  sealup keyscan [target] [flags]'),
  [],
  heading('TARGET'),
  ...plain(
    '  One target in sealup.yml: no name needed.',
    '  Several targets: name one. Without a name, a terminal shows a picker',
    '  and CI stops with exit 2, listing the names.',
  ),
  [],
  heading('ON A TERMINAL'),
  ...plain(
    '  It asks before it saves the key, and before it replaces another saved',
    '  key (no by default). Only the hostKey line of sealup.yml changes.',
  ),
  [],
  heading('WITHOUT A TERMINAL'),
  ...plain(
    '  It prints the hostKey line to paste and never writes: sealup never',
    '  trusts a server key from CI. Another key than the saved one: exit 4.',
    '',
    '  Global flags: -c, --env-file, --json, --no-color (sealup --help)',
  ),
  [],
  heading('EXAMPLES'),
  ...plain(
    '  $ sealup keyscan                   # the only target',
    '  $ sealup keyscan staging           # one of several targets',
  ),
  [],
  heading('LEARN MORE'),
  ...plain('  sealup help exit-codes    4: the server is not the one in sealup.yml.'),
  dim('https://sealup.dev/keyscan'),
];

/** Not on the page: S06's checks, the exit rule of decision 14. */
const check: readonly Line[] = [
  ...plain(
    'Check sealup.yml and its variables without touching the server: the file,',
    'the targets, the upload folders, the variables (their names and where they',
    'come from, never their values) and the host keys. The safety nets that',
    'need no server run too.',
  ),
  [],
  heading('USAGE'),
  ...plain('  sealup check [target] [flags]'),
  [],
  heading('TARGET'),
  ...plain(
    '  No name: every target. A problem of one target is a warning for it, and',
    '  the exit code is 0 when at least one target is ready.',
    '  A name: that target only.',
  ),
  [],
  heading('EXIT CODE'),
  ...plain(
    '  What a deploy would give before connecting: 0 ready, 2 a config or',
    '  variable problem, 4 no host key, 6 a safety net.',
    '',
    '  Global flags: -c, --env-file, --json, -q, --no-color (sealup --help)',
  ),
  [],
  heading('EXAMPLES'),
  ...plain(
    '  $ sealup check                     # every target',
    '  $ sealup check staging             # one target',
    '  $ sealup check --json              # one JSON object on stdout',
  ),
  [],
  heading('LEARN MORE'),
  ...plain('  sealup deploy -n          A dry run also checks the server.'),
  dim('https://sealup.dev/check'),
];

/** Not on the page: the topics. */
const help: readonly Line[] = [
  ...plain('Explain the commands, the keys of sealup.yml and the exit codes.'),
  [],
  heading('USAGE'),
  ...plain('  sealup help [topic]'),
  [],
  heading('TOPICS'),
  ...plain(
    '  init          Write sealup.yml, sealup.env and a GitHub workflow',
    '  deploy        Send changes to a target',
    '  pull          Copy server files (uploads) to this machine',
    "  keyscan       Show the server's host key and save it to sealup.yml",
    '  check         Check sealup.yml and its variables, offline',
    '  help          This text',
    '  config        The keys of sealup.yml',
    '  exit-codes    What each exit code means',
    '',
    '  sealup alone gives help for this project: its targets and commands.',
  ),
  [],
  heading('LEARN MORE'),
  dim('https://sealup.dev'),
];

const config: readonly Line[] = [
  ...plain(
    'sealup reads sealup.yml (or sealup.yaml) from this folder, then from parent',
    'folders up to the repo root.',
  ),
  [],
  heading('TARGET KEYS', '  top level for one target, or under targets.<name>'),
  ...plain(
    '  server           sftp|ssh|ftps|ftp://user@host[:port]/folder',
    `  password         $\{VAR} only`,
    `  privateKey       $\{VAR} only: the key's text, not a path`,
    `  passphrase       $\{VAR} only`,
    '  hostKey          OpenSSH line from sealup keyscan (sftp, ssh)',
    '  tlsFingerprint   certificate SHA-256 pin (ftps)',
    '  url              site address, shown after a deploy',
  ),
  [],
  heading('WHAT TO SEND', '  top level; a target can add its own'),
  ...plain(
    '  upload           local: server path (a folder or one file)',
    '  exclude          .gitignore patterns: never sent, never deleted',
    `  write            server path: $\{VAR} (a file written from a secret)`,
    '  pull             server path: local, for sealup pull',
  ),
  [],
  heading('MORE'),
  ...plain(
    '  targets          named targets (then no server at the top level)',
    '  allow            safety nets to turn off for a target',
    '  checkServer      put back files changed on the server (false)',
    '  parallel         SFTP requests in flight (64), FTP connections (4)',
    '  timeout          per operation (30s)',
    '  manifest         where sealup keeps its file list (.sealup/)',
  ),
  [],
  heading('VARIABLES'),
  ...plain(
    `  $\{VAR}, $\{VAR:?message}, $$ for a plain $.`,
    '  From the environment, and from sealup.env on your machine (--env-file).',
  ),
  [],
  heading('EXAMPLE'),
  ...plain(
    '  server: sftp://deploy@ssh.example.com/home/site/www',
    `  password: $\{SEALUP_PASSWORD}`,
    '  hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sx…',
    '  upload: dist',
  ),
  [],
  heading('LEARN MORE'),
  dim('https://sealup.dev/config'),
];

const exitCodes: readonly Line[] = [
  ...plain('Every exit code also tells you whether the server changed.'),
  [],
  heading('CODES'),
  dim('code  meaning                                     server changed'),
  ...plain(
    '     0  Done, or nothing to do                      maybe: that was the point',
    '     1  Stopped part-way                            yes, partly',
    '     2  Usage or config problem                     no',
    '     3  Login refused (never retried)               no',
    '     4  Server identity not confirmed               no',
    '     5  Server unreachable                          no',
    '     6  Stopped by a safety net                     no',
    '   130  Interrupted (Ctrl-C)                        maybe: see the last line',
  ),
  [],
  heading('DETAILS'),
  ...plain(
    '     1  Some changes are on the server, others are not. Running the same',
    '        command again finishes the job.',
    '     2  Bad flag, unknown or missing target, invalid sealup.yml, missing',
    '        variable, sealup pull in CI.',
    '     4  Host key missing or changed, or TLS certificate refused.',
    '     5  DNS, timeout, connection refused, or dropped before any change.',
    '     6  Empty source, risky folder, symlink, a secret file into a public',
    '        folder, or another run deploying to the same target.',
  ),
  [],
  heading('IN A SCRIPT'),
  ...plain(
    '  0: fine. 2 to 6: nothing changed, fix the cause first.',
    '  1: run the same command again. 130: read the last line, then run again.',
  ),
  [],
  heading('LEARN MORE'),
  dim('https://sealup.dev/exit-codes'),
];

const screens: Readonly<Record<HelpTopic, readonly Line[]>> = {
  init,
  deploy,
  pull,
  keyscan,
  check,
  help,
  config,
  'exit-codes': exitCodes,
};

/** The lines of a help screen: a topic's, or the overview (`sealup --help`). */
export function helpLines(topic?: HelpTopic): readonly Line[] {
  return topic === undefined ? overview : screens[topic];
}
