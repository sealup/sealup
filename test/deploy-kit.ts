// Fixtures for deploy tests (seam 1, `deploy()` behind the Session port) and CLI tests (seam 2,
// `main()`): a project in a real temp folder (its path holds a space), with sealup.yml and the
// build output, and the bits of a run every test needs. Later tickets add their own fixtures here.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { type Keyboard, main } from '../src/cli/index.ts';
import { loadConfig } from '../src/config/index.ts';
import {
  type Connect,
  type DeployEvent,
  type Outcome,
  type ScanCertificate,
  type ScanHostKey,
  type ServerPath,
  type Session,
  TransportError,
} from '../src/contracts/index.ts';
import { deploy } from '../src/deploy/index.ts';
import { manifestStore } from '../src/manifest/index.ts';
import {
  canaries,
  createMemoryServer,
  expectHiddenMasked,
  expectNoLeaks,
  githubLog,
  githubMasks,
  hiddenCanaries,
  splitMasks,
  steppedClock,
} from '../src/testkit/index.ts';

/**
 * The host key the golden scenarios print: `ssh-keygen -lf` gives
 * `SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM` for it (CLI page, S07-S20).
 */
export const hostKeyLine =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86';
export const hostKeyFingerprint = 'SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM';

/**
 * The first line of a log form (no terminal): sealup's version from source, then the command and
 * the target named, never a flag (spec #24 decision 27).
 */
export function versionLine(command?: string, target?: string): string {
  const words = [command, target].filter((word) => word !== undefined);
  return words.length === 0 ? 'sealup 0.0.0-source' : `sealup 0.0.0-source · ${words.join(' ')}`;
}

/**
 * The GitHub form's first lines when the config reads SEALUP_CANARY_PASSWORD (R2): its forms as
 * the secret module derives them (as it is, base64, base64url, URL-encoded, JSON-escaped, hex,
 * HEX), each `%` escaped as `%25` for GitHub to read back. Written out once, from the canary.
 */
export const canaryMasks: readonly string[] = [
  `::add-mask::Cn4ry-pw"'$/+=%25\\x7Qz-fake`,
  '::add-mask::Q240cnktcHciJyQvKz0lXHg3UXotZmFrZQ==',
  '::add-mask::Q240cnktcHciJyQvKz0lXHg3UXotZmFrZQ',
  "::add-mask::Cn4ry-pw%2522'%2524%252F%252B%253D%2525%255Cx7Qz-fake",
  `::add-mask::Cn4ry-pw\\"'$/+=%25\\\\x7Qz-fake`,
  '::add-mask::436e3472792d70772227242f2b3d255c7837517a2d66616b65',
  '::add-mask::436E3472792D70772227242F2B3D255C7837517A2D66616B65',
];

/** A job summary from its lines (Markdown), as the file ends: with a line break. */
export function markdown(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** The job summary's target table of the page's scenarios, the host key verified (R22). */
export const summaryTarget: readonly string[] = [
  '| Target | `sftp://deploy@ssh.example.com:22/home/site` |',
  '|---|---|',
  `| Host key | ED25519 \`${hostKeyFingerprint}\` verified |`,
  '| Site | https://example.com |',
];

/** The job summary's last line: sealup's version, then its docs or the problem's page. */
export function summaryFooter(slug?: string): string {
  const link =
    slug === undefined
      ? '[docs](https://sealup.dev)'
      : `[More: sealup.dev/e/${slug}](https://sealup.dev/e/${slug})`;
  return `<sub>sealup 0.0.0-source · ${link}</sub>`;
}

/** The environment of a run in GitHub Actions (the runner sets it; spec #24 decision 27). */
export const inGitHub: Readonly<Record<string, string>> = { GITHUB_ACTIONS: 'true' };

/** `${NAME}`, a variable reference in sealup.yml (built, so linters read it as config). */
export const ref = (name: string): string => `$\{${name}}`;

/** The config of the page's scenarios: target `production`, folder `/home/site` (goldens.md). */
export function productionConfig(
  options: {
    readonly upload?: string;
    readonly password?: string;
    readonly hostKey?: boolean;
  } = {},
): string {
  return [
    `upload: ${options.upload ?? 'public_html'}`,
    'targets:',
    '  production:',
    '    server: sftp://deploy@ssh.example.com:22/home/site',
    `    password: ${ref(options.password ?? 'PROD_PASSWORD')}`,
    ...(options.hostKey === false ? [] : [`    hostKey: ${hostKeyLine}`]),
    '    url: https://example.com',
    '',
  ].join('\n');
}

interface Project {
  /** The project folder (holds a space). */
  readonly root: string;
  /** Its sealup.yml. */
  readonly config: string;
}

const projects: string[] = [];
afterEach(() => {
  for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A project in a fresh temp folder, removed after the test: `sealup.yml` and the files, by
 * `/`-separated path relative to the project folder.
 */
export function createProject(
  config: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Project {
  const root = mkdtempSync(join(tmpdir(), 'sealup project '));
  projects.push(root);
  writeFileSync(join(root, 'sealup.yml'), config);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, config: join(root, 'sealup.yml') };
}

/**
 * A project without sealup.yml (`sealup init`), in a fresh temp folder removed after the test:
 * the files, by `/`-separated path. Its folder holds `.git`, so it is the repo root.
 */
export function newProject(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'sealup project '));
  projects.push(root);
  for (const [path, content] of Object.entries({
    '.git/HEAD': 'ref: refs/heads/main\n',
    ...files,
  })) {
    const full = join(root, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

export interface MainRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The GitHub job summary file after the run (spec #24 decision 32): `''` when the run wrote
   * none, or was not in GitHub's form.
   */
  readonly summary: string;
}

interface MainOptions {
  readonly cwd: string;
  /** The environment; the canaries are always added (leak test, R1). */
  readonly env?: Readonly<Record<string, string>>;
  /** Whether stdout and stderr are terminals (both; default no). */
  readonly tty?: boolean;
  /** Whether stdin is a terminal (default: as `tty`). */
  readonly stdinTTY?: boolean;
  /**
   * What the person types at the terminal, one chunk per read (spec #24 decision 16); a run
   * that reads past them fails.
   */
  readonly keys?: readonly string[];
  readonly clock?: () => number;
  /** `process.platform` as main() sees it (default `linux`). */
  readonly platform?: string;
  /** The server to deploy to; a run that connects without one fails the test. */
  readonly server?: { connect(): Promise<Session> };
  /** Or a Connect that takes the target: the real transport (test/sftp-kit.ts `dialing`). */
  readonly connect?: Connect;
  /**
   * The host-key scan (`keyscan`): a memory server's `scanHostKey`, or the real transport's
   * (test/sftp-kit.ts `scanDialing`); a run that scans without one fails the test.
   */
  readonly scan?: ScanHostKey;
  /**
   * The certificate scan (`keyscan` on `ftps://`): the real transport's, pointed at a test
   * server; a run that scans without one fails the test.
   */
  readonly scanCertificate?: ScanCertificate;
  /** Ctrl-C: the AbortSignal main() is given. */
  readonly signal?: AbortSignal;
  /** This machine's name, for the lock's note (default: the test machine's own). */
  readonly machine?: string;
  /**
   * The wait before a reconnect try (spec #41 decision 20). Default: none at all, so a test that
   * drops a connection does not wait the real 1 + 2 + 4 s.
   */
  readonly wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /**
   * More values the run must hide as it hides the hidden canaries (0045), by name: what the
   * test's server shows of itself (its key, its certificate) when the target hides a part.
   */
  readonly hidden?: Readonly<Record<string, string>>;
}

/** No wait: a reconnect's tries come at once in tests. */
export const noWait = async (): Promise<void> => {};

/**
 * `connect` for the first session only; every later connect finds the server unreachable (spec
 * #41 decision 20): a connection lost during the transfer stays lost, and the run stops on it
 * once its 3 reconnect tries are spent.
 */
export function onlyOnce(connect: Connect): Connect {
  let connects = 0;
  return async (target, options) => {
    if (connects++ > 0) throw new TransportError('unreachable', 'refused');
    return connect(target, options);
  };
}

/**
 * A fresh, empty job summary file, as the runner makes one for each step; its folder is removed
 * after the test.
 */
export function summaryFile(): string {
  const folder = mkdtempSync(join(tmpdir(), 'sealup summary '));
  projects.push(folder);
  const file = join(folder, 'step_summary');
  writeFileSync(file, '');
  return file;
}

/**
 * Runs `main()` in process with its streams captured, the canary secrets in its environment, and
 * the leak check on what it printed (GitHub's leading mask lines excepted) and on the job summary.
 * The hidden canaries (a public repo's server and host key, 0045) are in its environment too:
 * in GitHub's form, none may show once the log's masks apply; in any form, none in the summary.
 * A run in GitHub's form gets a fresh job summary file unless its environment names one. The
 * terminal's raw mode must be off again when main() returns.
 */
export async function runMain(argv: readonly string[], options: MainOptions): Promise<MainRun> {
  let stdout = '';
  let stderr = '';
  const tty = options.tty ?? false;
  const keyboard = typing(options.keys ?? [], 'fail');
  const server = options.server;
  const inActions = options.env?.GITHUB_ACTIONS === 'true';
  const summaryPath = options.env?.GITHUB_STEP_SUMMARY ?? (inActions ? summaryFile() : undefined);
  const exitCode = await main(
    argv,
    {
      ...canaries,
      ...hiddenCanaries,
      ...options.env,
      ...(summaryPath === undefined ? {} : { GITHUB_STEP_SUMMARY: summaryPath }),
    },
    {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      stdoutIsTTY: tty,
      stderrIsTTY: tty,
      stdin: keyboard,
      stdinIsTTY: options.stdinTTY ?? tty,
      cwd: options.cwd,
      platform: options.platform ?? 'linux',
      clock: options.clock ?? steppedClock(0),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.machine === undefined ? {} : { machine: options.machine }),
      wait: options.wait ?? noWait,
      connect: async (target, connectOptions) => {
        if (options.connect !== undefined) return options.connect(target, connectOptions);
        if (server === undefined) throw new Error('the test gave runMain no server to connect to');
        return server.connect();
      },
      scanHostKey: async (url, scanOptions) => {
        if (options.scan === undefined) throw new Error('the test gave runMain no scan');
        return options.scan(url, scanOptions);
      },
      scanCertificate: async (url, scanOptions) => {
        if (options.scanCertificate === undefined) {
          throw new Error('the test gave runMain no certificate scan');
        }
        return options.scanCertificate(url, scanOptions);
      },
    },
  );
  if (keyboard.rawMode()) throw new Error('main() returned with the terminal still in raw mode');
  // GitHub's form starts with its mask lines, the one place a secret is written (R2): the canary
  // may be there, and nowhere else.
  const github = !tty && inActions;
  const human = github ? splitMasks(stderr).rest : stderr;
  const summary = summaryPath === undefined ? '' : readSummary(summaryPath);
  expectNoLeaks({ stdout, stderr: human, json: parseJson(stdout), summary });
  // A server or host key read from a variable (0045): GitHub masks it, the summary never holds
  // it; a terminal and a plain log show it whole (R22). A mask registered later in the log hides
  // only what follows it; the `--json` object on stdout is written once the run is over.
  const also = options.hidden ?? {};
  if (github) {
    const shown = githubMasks(stderr);
    expectHiddenMasked({ stdout: shown(stdout), stderr: githubLog(stderr), summary }, also);
  } else {
    expectHiddenMasked({ summary }, also);
  }
  return { exitCode, stdout, stderr, summary };
}

function readSummary(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A terminal's keyboard for tests: what a test types, and whether raw mode is on. */
interface TestKeyboard extends Keyboard {
  /** Types more: one chunk, as a terminal sends a key (or a paste). */
  type(chunk: string): void;
  /** Whether raw mode is on now. */
  rawMode(): boolean;
}

/**
 * A terminal's keyboard that types `keys`, one chunk per read (spec #24 decision 16). Once they
 * are all read, a read waits for `type()`, or with `whenOut: 'fail'` fails the run: a test that
 * gave too few keys must not wait forever. Reading outside raw mode fails too.
 */
export function typing(keys: readonly string[], whenOut: 'wait' | 'fail' = 'wait'): TestKeyboard {
  const queue = [...keys];
  let raw = false;
  let waiting: ((chunk: string | undefined) => void) | undefined;
  return {
    open: () => {
      raw = true;
    },
    close: () => {
      raw = false;
      waiting?.(undefined);
      waiting = undefined;
    },
    read: async () => {
      if (!raw) throw new Error('the keyboard was read outside raw mode');
      const next = queue.shift();
      if (next !== undefined) return next;
      if (whenOut === 'fail') throw new Error('the test typed no more keys');
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    type: (chunk) => {
      if (waiting === undefined) queue.push(chunk);
      else {
        const resolve = waiting;
        waiting = undefined;
        resolve(chunk);
      }
    },
    rawMode: () => raw,
  };
}

/** Collects the events of a run. */
export function eventLog(): { readonly events: DeployEvent[]; emit(event: DeployEvent): void } {
  const events: DeployEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

const siteEnv = { PROD_PASSWORD: 'pw-for-tests' };
type MemoryServer = ReturnType<typeof createMemoryServer>;

/** A project deployed to one memory server, whose build a test can change between runs. */
export async function memorySite(
  files: Record<string, string>,
  options: { config?: string; quick?: boolean; env?: Readonly<Record<string, string>> } = {},
) {
  const project = createProject(options.config ?? productionConfig(), files);
  const server = createMemoryServer({ loginFolder: '/home/deploy', quick: options.quick === true });
  let env = { ...siteEnv, ...options.env };
  /** How far the next runs are ahead of the real clock (ms): the lock's note ages by it. */
  let ahead = 0;
  const run = async (
    connect: Connect = () => server.connect(),
    dryRun = false,
  ): Promise<{ outcome: Outcome; events: DeployEvent[] }> => {
    const loaded = await loadConfig(project.config, env);
    if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
    const log = eventLog();
    const outcome = await deploy(
      { config: loaded.config, target: 'production', dryRun },
      {
        connect,
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0, 3_100),
        now: () => Date.now() + ahead,
        wait: noWait,
      },
    );
    return { outcome, events: log.events };
  };
  return {
    server,
    run,
    /** The project folder. */
    root: project.root,
    /**
     * Lets `ms` pass before the next runs, on their clock and the server's: a lock a killed run
     * left is taken over once the server has seen nothing of it for 10 minutes (decision 0040).
     */
    passTime(ms: number) {
      ahead += ms;
      server.passTime(ms);
    },
    /** Moves this machine's clock alone by `ms` (negative: behind the server's). */
    skewClock(ms: number) {
      ahead += ms;
    },
    /** Sets the variables of the next runs (added to the fixture's password). */
    setEnv(vars: Readonly<Record<string, string>>) {
      env = { ...siteEnv, ...vars };
    },
    write(path: string, content: string) {
      const full = join(project.root, ...path.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(path: string) {
      rmSync(join(project.root, ...path.split('/')), { recursive: true });
    },
    setConfig(yaml: string) {
      writeFileSync(project.config, yaml);
    },
  };
}

/** The files under the target folder, relative to it. */
export function siteFiles(server: MemoryServer): string[] {
  return [...server.files().keys()]
    .filter((path) => path.startsWith('/home/site/'))
    .map((path) => path.slice('/home/site/'.length));
}

export async function manifestPaths(server: MemoryServer): Promise<string[]> {
  const read = await manifestStore(await server.connect(), {
    folder: '/home/deploy/.sealup' as ServerPath,
    target: '/home/site' as ServerPath,
  }).read();
  if (read.kind !== 'found') throw new Error(`no manifest (${read.kind})`);
  return [...read.manifest.files.keys()];
}

export type MemorySite = Awaited<ReturnType<typeof memorySite>>;

/** The date of every file a pull fixture's server holds: whole seconds, as a server gives it. */
const pullMtime = 1_700_000_000;

/** Bytes of a given size, different for each seed. */
const sized = (seed: number, size: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed * 7) % 256);

/**
 * The page's pull (S24), small: the server holds www/resources with four files; two of them are
 * here already (the same size and date), two are new (5.0 KB). The config is the page's
 * production target with `pull: www/resources: public_html/resources`, its password the canary.
 * `seed: false` leaves the server as it is (a test seeds its own).
 */
export function pullProject(
  server: { seedFile(path: string, content: Uint8Array, facts: { mtime: number }): void },
  options: { readonly config?: string; readonly seed?: boolean } = {},
) {
  const served: Record<string, Uint8Array> = {
    '2024/01/photo-1.jpg': sized(1, 2048),
    '2024/01/photo-2.jpg': sized(2, 3072),
    'avatar.png': sized(3, 100),
    'logo.png': sized(4, 512),
  };
  if (options.seed !== false) {
    for (const [path, content] of Object.entries(served)) {
      server.seedFile(`/home/site/www/resources/${path}`, content, { mtime: pullMtime });
    }
  }
  const config =
    options.config ??
    productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }).replace(
      'targets:',
      'pull:\n  www/resources: public_html/resources\ntargets:',
    );
  const here = ['avatar.png', 'logo.png'];
  const project = createProject(config, {
    'public_html/index.html': 'x',
    ...Object.fromEntries(
      here.map((path) => [`public_html/resources/${path}`, served[path] ?? '']),
    ),
  });
  for (const path of here) {
    utimesSync(join(project.root, 'public_html', 'resources', path), pullMtime, pullMtime);
  }
  return { ...project, served, mtime: pullMtime };
}

/** The page's staging key (reference.js, the typical config). */
const stagingKeyLine =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIMytt7XOtQoLfxloYx9nFD1pYMdoQ6Dwr6b8D+pHN8R';

/**
 * The page's typical config, two targets (S05, S06), adapted to what this version honours:
 * staging's `ssh://` is `sftp://` (lane A). Staging logs in with the page's
 * `privateKey: ${STAGING_KEY}` (decision 0033). Line 14 is staging's privateKey; with `write`
 * (the page's `api/.env: ${APP_ENV}`, lines 5 and 6), line 16; `pull` adds the page's
 * `www/resources: public_html/resources` after them.
 */
export function twoTargetConfig(
  options: { readonly write?: boolean; readonly pull?: boolean } = {},
): string {
  return [
    'upload:',
    '  public_html: www',
    '  api: api',
    'exclude: [public_html/resources, api/storage, api/.env*]',
    ...(options.write === true ? ['write:', `  api/.env: ${ref('APP_ENV')}`] : []),
    ...(options.pull === true ? ['pull:', '  www/resources: public_html/resources'] : []),
    '',
    'targets:',
    '  production:',
    '    server: sftp://deploy@ssh.example.com/home/site',
    `    password: ${ref('PROD_PASSWORD')}`,
    `    hostKey: ${hostKeyLine}`,
    '    url: https://example.com',
    '  staging:',
    '    server: sftp://deploy@203.0.113.10/srv/site',
    `    privateKey: ${ref('STAGING_KEY')}`,
    `    hostKey: ${stagingKeyLine}`,
    '',
  ].join('\n');
}
