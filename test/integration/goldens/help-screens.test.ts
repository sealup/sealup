// Goldens of the four help screens (CLI page, docs/exploration/assets/06/reference.js `help`:
// `help`, `help-deploy`, `help-config`, `help-exit-codes`), spec #24 decision 13: on stdout,
// exit 0, byte for byte. Each text is the page's, minus what this version cannot honour; every
// cut is listed above its screen, so a ticket that brings a feature back knows its line.

import { describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import { createProject, productionConfig, ref, runMain } from '../../deploy-kit.ts';

// `sealup help` is `sealup --help`. Not on the page: `--dry-run` and `--debug` among the global flags
// (this version's own lines, ticket 04's help). The command `init` and `$ sealup init` are the
// page's lines back (#36).
const help = [
  'Deploy your build to shared hosting over SFTP, SSH or FTP.',
  'Only changed files travel.',
  '',
  '{b}USAGE{/}',
  '  sealup <command> [target] [flags]',
  '',
  '{b}COMMANDS{/}',
  '  init        Write sealup.yml, sealup.env and a GitHub workflow',
  '  deploy      Send changes to a target',
  '  pull        Copy server files (uploads) to this machine',
  "  keyscan     Show the server's host key and save it to sealup.yml",
  '  check       Check sealup.yml and its variables, offline',
  '  help        Commands, config keys, exit codes',
  '',
  '{b}FLAGS{/}',
  '  -c, --config <file>     Use this config file (default: sealup.yml)',
  '      --env-file <file>   Read variables from this file (default: sealup.env)',
  '      --dry-run           Show every change, change nothing',
  '      --json              Print one JSON object on stdout',
  '  -v, --verbose           Show the file list and timings',
  '  -q, --quiet             Show the result line only',
  '      --no-color          No colour (NO_COLOR works too)',
  '      --debug             Show where an unexpected error happened',
  '  -h, --help              Show help for a command',
  '      --version           Show the version',
  '',
  '{b}EXAMPLES{/}',
  '  $ sealup init',
  '  $ sealup deploy --dry-run',
  '  $ sealup deploy production',
  '',
  '{b}LEARN MORE{/}',
  '  sealup                    Help for this project (reads sealup.yml)',
  '  sealup help <command>     Details for one command',
  '  sealup help config        The keys of sealup.yml',
  '  sealup help exit-codes    What each exit code means',
  '  {d}https://sealup.dev{/}',
];

// The risky target folder is back among the safety nets (decision 0029). `--mirror` is back
// (decision 0030), and `--check-server` is this version's own line (spec #41 decision 26). The
// opt-outs said as this version has them: `allow:` turns off the empty build folder, the risky
// folder and symlinks, the secret file's is `allowPublic:` on its entry (#33). The picker on a
// terminal is the page's line (#30).
const helpDeploy = [
  'Send the changes in your build to a target. New and changed files go up.',
  'Files that sealup uploaded before and that are gone from your build are',
  'deleted. Everything else on the server is left alone.',
  '',
  '{b}USAGE{/}',
  '  sealup deploy [target] [flags]',
  '',
  '{b}TARGET{/}',
  '  One target in sealup.yml: no name needed.',
  '  Several targets: name one. Without a name, a terminal shows a picker',
  '  and CI stops with exit 2, listing the names.',
  '',
  '{b}FLAGS{/}',
  '      --dry-run             Show every change, change nothing',
  '      --mirror              Also delete server files sealup did not upload',
  '                            (minus excludes). Slower: lists the whole server',
  '      --check-server        Also put back files changed on the server',
  '',
  '  Global flags: -c, --env-file, --json, -v, -q, --no-color (sealup --help)',
  '',
  '{b}SAFETY{/}',
  '  There is no confirmation: the dry run is the review step.',
  '  sealup stops before changing anything on an empty build folder, a risky',
  '  target folder, a symlink, or a secret file in a public folder. Opt-outs',
  '  in sealup.yml: allow: for all but the secret file, allowPublic: for it.',
  '',
  '{b}EXAMPLES{/}',
  '  $ sealup deploy --dry-run          # see what would change',
  '  $ sealup deploy                    # the only target',
  '  $ sealup deploy staging            # one of several targets',
  '  $ sealup deploy production --json  # one JSON object on stdout',
  '',
  '{b}LEARN MORE{/}',
  '  sealup help exit-codes    Did the server change? The exit code says.',
  '  {d}https://sealup.dev/deploy{/}',
];

// Not on the page (#31): `help keyscan`, in the layout of the page's screens, from S04's states
// and spec #24 decision 18.
const helpKeyscan = [
  "Show the server's host key and save it to sealup.yml as hostKey, once you",
  "have compared its fingerprint with your host's. sealup checks this key",
  'before it sends your password. keyscan never logs in: it reads no password.',
  '',
  '{b}USAGE{/}',
  '  sealup keyscan [target] [flags]',
  '',
  '{b}TARGET{/}',
  '  One target in sealup.yml: no name needed.',
  '  Several targets: name one. Without a name, a terminal shows a picker',
  '  and CI stops with exit 2, listing the names.',
  '',
  '{b}ON A TERMINAL{/}',
  '  It asks before it saves the key, and before it replaces another saved',
  '  key (no by default). Only the hostKey line of sealup.yml changes.',
  '',
  '{b}WITHOUT A TERMINAL{/}',
  '  It prints the hostKey line to paste and never writes: sealup never',
  '  trusts a server key from CI. Another key than the saved one: exit 4.',
  '',
  '  Global flags: -c, --env-file, --json, --no-color (sealup --help)',
  '',
  '{b}EXAMPLES{/}',
  '  $ sealup keyscan                   # the only target',
  '  $ sealup keyscan staging           # one of several targets',
  '',
  '{b}LEARN MORE{/}',
  '  sealup help exit-codes    4: the server is not the one in sealup.yml.',
  '  {d}https://sealup.dev/keyscan{/}',
];

// The page's TARGET KEYS, every protocol and key back (ssh 0034, ftp T03, ftps and
// tlsFingerprint T04, privateKey and passphrase 0033). The page's `remote` side of upload, write
// and pull is `server path` (GLOSSARY: remote is a word sealup avoids).
const helpConfig = [
  'sealup reads sealup.yml (or sealup.yaml) from this folder, then from parent',
  'folders up to the repo root.',
  '',
  '{b}TARGET KEYS{/}  top level for one target, or under targets.<name>',
  '  server           sftp|ssh|ftps|ftp://user@host[:port]/folder',
  `  password         ${ref('VAR')} only`,
  `  privateKey       ${ref('VAR')} only: the key's text, not a path`,
  `  passphrase       ${ref('VAR')} only`,
  '  hostKey          OpenSSH line from sealup keyscan (sftp, ssh)',
  '  tlsFingerprint   certificate SHA-256 pin (ftps)',
  '  url              site address, shown after a deploy',
  '',
  '{b}WHAT TO SEND{/}  top level; a target can add its own',
  '  upload           local: server path (a folder or one file)',
  '  exclude          .gitignore patterns: never sent, never deleted',
  `  write            server path: ${ref('VAR')} (a file written from a secret)`,
  '  pull             server path: local, for sealup pull',
  '',
  '{b}MORE{/}',
  '  targets          named targets (then no server at the top level)',
  '  allow            safety nets to turn off for a target',
  '  checkServer      put back files changed on the server (false)',
  '  parallel         SFTP requests in flight (64), FTP connections (4)',
  '  timeout          per operation (30s)',
  '  manifest         where sealup keeps its file list (.sealup/)',
  '',
  '{b}VARIABLES{/}',
  `  ${ref('VAR')}, ${ref('VAR:?message')}, $$ for a plain $.`,
  '  From the environment, and from sealup.env on your machine (--env-file).',
  '',
  '{b}EXAMPLE{/}',
  '  server: sftp://deploy@ssh.example.com/home/site/www',
  `  password: ${ref('SEALUP_PASSWORD')}`,
  '  hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sx…',
  '  upload: dist',
  '',
  '{b}LEARN MORE{/}',
  '  {d}https://sealup.dev/config{/}',
];

// 6 has the page's risky folder (decision 0029) and the lock (decision 0031). 4 has the page's
// TLS certificate (plan 05 T04).
const helpExitCodes = [
  'Every exit code also tells you whether the server changed.',
  '',
  '{b}CODES{/}',
  '  {d}code  meaning                                     server changed{/}',
  '     0  Done, or nothing to do                      maybe: that was the point',
  '     1  Stopped part-way                            yes, partly',
  '     2  Usage or config problem                     no',
  '     3  Login refused (never retried)               no',
  '     4  Server identity not confirmed               no',
  '     5  Server unreachable                          no',
  '     6  Stopped by a safety net                     no',
  '   130  Interrupted (Ctrl-C)                        maybe: see the last line',
  '',
  '{b}DETAILS{/}',
  '     1  Some changes are on the server, others are not. Running the same',
  '        command again finishes the job.',
  '     2  Bad flag, unknown or missing target, invalid sealup.yml, missing',
  '        variable, sealup pull in CI.',
  '     4  Host key missing or changed, or TLS certificate refused.',
  '     5  DNS, timeout, connection refused, or dropped before any change.',
  '     6  Empty source, risky folder, symlink, a secret file into a public',
  '        folder, or another run deploying to the same target.',
  '',
  '{b}IN A SCRIPT{/}',
  '  0: fine. 2 to 6: nothing changed, fix the cause first.',
  '  1: run the same command again. 130: read the last line, then run again.',
  '',
  '{b}LEARN MORE{/}',
  '  {d}https://sealup.dev/exit-codes{/}',
];

// Not on the page: S24 and S25's rules (spec #24 decision 25), in the layout of `help deploy`.
const helpPull = [
  "Copy server files (the users' uploads) to this machine. New files come down,",
  "and a local file of another size or date is replaced by the server's copy.",
  'Local files are never deleted, and nothing is written outside the folder of',
  'sealup.yml.',
  '',
  '{b}USAGE{/}',
  '  sealup pull [target] [flags]',
  '',
  '{b}TARGET{/}',
  '  One target in sealup.yml: no name needed.',
  '  Several targets: name one. Without a name, a terminal shows a picker.',
  '',
  '{b}FLAGS{/}',
  '      --dry-run             List every file to download, change nothing',
  '',
  '  Global flags: -c, --env-file, --json, -v, -q, --no-color (sealup --help)',
  '',
  '{b}SAFETY{/}',
  '  On your own machine only: without a terminal (CI) it stops with exit 2.',
  '  It stops before writing anything on a server name that Windows or a path',
  '  cannot hold, a link or junction on the local path, or a listing too large.',
  '  Links on the server are skipped, never followed.',
  '',
  '{b}EXAMPLES{/}',
  '  $ sealup pull --dry-run            # see what would come down',
  '  $ sealup pull production           # one of several targets',
  '',
  '{b}LEARN MORE{/}',
  '  sealup help config        The pull: key of sealup.yml',
  '  {d}https://sealup.dev/pull{/}',
];

// Not on the page (#36): `help init`, in the layout of the page's screens, from S02 and spec
// #24 decisions 19-21. It never names the sam-sync conversion or its flag (0023 §9).
const helpInit = [
  'Set up this project: find the build folder and the build command, ask for',
  "the server address and check the server's key, keep the password in",
  'sealup.env (git-ignored), and write sealup.yml and a GitHub workflow.',
  '',
  '{b}USAGE{/}',
  '  sealup init [flags]',
  '',
  '{b}ON A TERMINAL{/}',
  "  It asks for the server address, shows the server's host key and saves it",
  '  on a yes, then asks for the password (hidden).',
  '',
  '{b}WITHOUT A TERMINAL{/}',
  '  --server or --from is needed. sealup.yml gets a host-key placeholder:',
  '  run sealup keyscan on your computer. --from moves the old connection',
  '  password into sealup.env; --server writes no sealup.env.',
  '',
  '{b}FLAGS{/}',
  '      --server <url>        sftp|ssh|ftps|ftp://user@host[:port]/folder',
  '      --from <file>         Convert a sam-sync deployment file',
  '',
  '  Global flags: --json, --no-color (sealup --help)',
  '',
  '{b}NEVER OVERWRITES{/}',
  '  An existing sealup.yml stops it (exit 2). An existing workflow is left as',
  '  it is; an existing sealup.env only gets SEALUP_PASSWORD when it lacks it.',
  '',
  '{b}EXAMPLES{/}',
  '  $ sealup init',
  '  $ sealup init --server sftp://deploy@ssh.example.com/home/site/www',
  '',
  '{b}LEARN MORE{/}',
  '  sealup help config        The keys of sealup.yml',
  '  {d}https://sealup.dev/init{/}',
];

function project(): string {
  return createProject(productionConfig(), { 'public_html/index.html': 'x' }).root;
}

describe('help screens', () => {
  it.each([
    ['help', ['help'], help],
    ['--help', ['--help'], help],
    ['help deploy', ['help', 'deploy'], helpDeploy],
    ['deploy --help', ['deploy', '--help'], helpDeploy],
    ['help keyscan', ['help', 'keyscan'], helpKeyscan],
    ['keyscan --help', ['keyscan', '--help'], helpKeyscan],
    ['help config', ['help', 'config'], helpConfig],
    ['help exit-codes', ['help', 'exit-codes'], helpExitCodes],
    ['help pull', ['help', 'pull'], helpPull],
    ['pull --help', ['pull', '--help'], helpPull],
    ['help init', ['help', 'init'], helpInit],
    ['init --help', ['init', '--help'], helpInit],
  ])('sealup %s prints the page screen on stdout, exit 0', async (_, argv, lines) => {
    // No server and no variables: help reads nothing and connects nowhere.
    const run = await runMain(argv, { cwd: project(), tty: true });
    expect(run.stdout).toBe(goldenText(lines, { color: true }));
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
  });

  it('prints the same words without colour when stdout is not a terminal', async () => {
    const run = await runMain(['help', 'exit-codes'], { cwd: project() });
    expect(run.stdout).toBe(goldenText(helpExitCodes, { color: false }));
  });

  it('fits every line of every screen in 80 columns', () => {
    for (const line of [
      ...help,
      ...helpDeploy,
      ...helpPull,
      ...helpKeyscan,
      ...helpInit,
      ...helpConfig,
      ...helpExitCodes,
    ]) {
      expect(line.replace(/\{\w*\/?\}/g, '').length, line).toBeLessThanOrEqual(80);
    }
  });
});
