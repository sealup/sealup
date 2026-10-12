// init: `sealup init` sets up a project (spec #24 decisions 19-21, S02; 0022 §6-§7, 0024 §11).
//
// Decision hidden: what it reads in the project folder (the upload folder and its file count,
// the build command from package.json and the package manager its lockfile names, the Node
// version file, the files already there), the GitHub workflow it writes (exploration 06 §5.1),
// and how each file is written without overwriting anything.
//
// Interface: readProject(folder) gives the Project found; workflowText(options) the workflow's
// text; writeProject(plan) writes sealup.yml (from config's newConfigText), sealup.env (the
// password through config's withEnvVariable), the `sealup.env` line in .gitignore and the
// workflow, and gives each file and what happened to it, or the problem of a sealup.yml already
// there; a public repository's server and host key go to sealup.env as plain values (0045). cli
// asks the questions (the server, the host key, whether the repo is public, the password) and
// report words the screen. The sam-sync conversion (#37, undocumented) is a second way to make
// the plan: readSamSync(folder, file) reads a sam-sync file, its download file and what the
// conversion needs, convertSamSync (sam-sync.ts, pure) turns them into sealup.yml's facts and
// convertedConfigText into its text; sealup.env gets the password and each secret file's content.
//
// Invariants: never overwrites. sealup.yml is created exclusively, first: one already there stops
// init with nothing written. An existing workflow is left as it is; an existing sealup.env only
// gets a variable it does not set, appended; .gitignore gets its line once. sealup.env is
// created with mode 0600 (where the system has modes). No child process: the build command is
// written into the workflow, never run here.
//
// Must never know: argv, the terminal, how anything is worded, the server.

import { appendFile, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import {
  type EnvSecret,
  type EnvValue,
  envSecret,
  findRepoRoot,
  isFile,
  isMissing,
  passwordVariable,
  withEnvVariable,
} from '../config/index.ts';
import type { Problem, Secret } from '../contracts/index.ts';
import { convertSamSync, type SamSyncResult } from './sam-sync.ts';

export {
  convertedConfigText,
  convertSamSync,
  type SamSyncConversion,
} from './sam-sync.ts';

/** The folders a build writes to, in the order init looks (spec #24 decision 19). */
const uploadFolders = ['dist', 'build', 'out', 'public', '_site'] as const;

/** The build: `install` then `run`, in the workflow. */
export interface Build {
  readonly manager: 'npm' | 'pnpm' | 'yarn';
  readonly install: string;
  readonly run: string;
}

/** What init found in the project folder. */
export interface Project {
  /** The project folder, absolute: where sealup.yml goes. */
  readonly folder: string;
  /** The first upload folder that holds files, and how many (in every folder below it). */
  readonly upload?: { readonly folder: string; readonly files: number };
  readonly build?: Build;
  /** `.nvmrc` or `.node-version`, when the project has one. */
  readonly nodeVersionFile?: string;
  /** sealup.yml or sealup.yaml in the project folder, when there is one. */
  readonly existingConfig?: string;
  /** The workflow file, at the repo root (or the project folder outside a repo). */
  readonly workflow: { readonly file: string; readonly exists: boolean };
  /** The project folder from the repo root, `/`-separated; `''` at the root. */
  readonly fromRepoRoot: string;
  /** sealup.env already sets SEALUP_PASSWORD (not empty). */
  readonly envHasPassword: boolean;
  /** A sam-sync `.deployment.json` is in the project folder. */
  readonly deploymentJson: boolean;
}

export async function readProject(folder: string): Promise<Project> {
  const root = (await findRepoRoot(folder)) ?? folder;
  const workflow = join(root, '.github', 'workflows', 'deploy.yml');
  const existing = [];
  for (const name of ['sealup.yml', 'sealup.yaml']) {
    if (await isFile(join(folder, name))) existing.push(join(folder, name));
  }
  const [existingConfig] = existing;
  const upload = await findUpload(folder);
  const build = await findBuild(folder);
  const nodeVersionFile = (await isFile(join(folder, '.nvmrc')))
    ? '.nvmrc'
    : (await isFile(join(folder, '.node-version')))
      ? '.node-version'
      : undefined;
  const env = await readText(join(folder, 'sealup.env'));
  const password = env === undefined ? undefined : parseEnv(env)[passwordVariable];
  return {
    folder,
    ...(upload === undefined ? {} : { upload }),
    ...(build === undefined ? {} : { build }),
    ...(nodeVersionFile === undefined ? {} : { nodeVersionFile }),
    ...(existingConfig === undefined ? {} : { existingConfig }),
    workflow: { file: workflow, exists: await isFile(workflow) },
    fromRepoRoot: relative(root, folder).split(sep).join('/'),
    envHasPassword: password !== undefined && password !== '',
    deploymentJson: await isFile(join(folder, '.deployment.json')),
  };
}

async function findUpload(folder: string): Promise<Project['upload']> {
  for (const name of uploadFolders) {
    let files: number;
    try {
      const entries = await readdir(join(folder, name), { recursive: true, withFileTypes: true });
      files = entries.filter((entry) => entry.isFile()).length;
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (files > 0) return { folder: name, files };
  }
  return undefined;
}

async function findBuild(folder: string): Promise<Build | undefined> {
  const text = await readText(join(folder, 'package.json'));
  if (text === undefined) return undefined;
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
  } catch {
    return undefined;
  }
  const build = (scripts as Record<string, unknown> | undefined)?.build;
  if (typeof build !== 'string' || build.trim() === '') return undefined;
  if (await isFile(join(folder, 'pnpm-lock.yaml'))) {
    return {
      manager: 'pnpm',
      install: 'corepack enable && pnpm install --frozen-lockfile',
      run: 'pnpm run build',
    };
  }
  if (await isFile(join(folder, 'yarn.lock'))) {
    return {
      manager: 'yarn',
      install: 'corepack enable && yarn install --frozen-lockfile',
      run: 'yarn run build',
    };
  }
  const locked =
    (await isFile(join(folder, 'package-lock.json'))) ||
    (await isFile(join(folder, 'npm-shrinkwrap.json')));
  return { manager: 'npm', install: locked ? 'npm ci' : 'npm install', run: 'npm run build' };
}

/**
 * The pins of this repo's CI (.github/workflows/ci.yml): a test keeps them equal (spec #24
 * decision 21). The sealup step's pin is sealupStep's.
 */
const checkoutPin = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const setupNodePin = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0';

/** The environment and concurrency group of init's one target (the shorthand). */
const environmentName = 'production';

/**
 * The workflow (exploration 06 §5.1, spec #24 decision 21): on push to main, read-only token,
 * one deploy at a time and never cancelled, a GitHub environment linked to the site, checkout
 * without credentials, Node and the build when there is one, then the sealup step with the
 * password from a secret through `env:`. `fromRepoRoot`: where the project is in the repo.
 */
export function workflowText(options: {
  /** sealup's version: the sealup step's tag. */
  readonly version: string;
  readonly build?: Build;
  readonly nodeVersionFile?: string;
  readonly fromRepoRoot: string;
  /** The variables the sealup step gets from secrets (default: the password's). */
  readonly variables?: readonly string[];
}): string {
  const { build, fromRepoRoot } = options;
  const inProject = (path: string) => (fromRepoRoot === '' ? path : `${fromRepoRoot}/${path}`);
  const workingDirectory = (indent: string) =>
    fromRepoRoot === '' ? [] : [`${indent}working-directory: ${yamlString(fromRepoRoot)}`];
  const node =
    options.nodeVersionFile === undefined
      ? 'node-version: 24'
      : `node-version-file: ${yamlString(inProject(options.nodeVersionFile))}`;
  const lines = [
    '# Deploys with sealup on every push to main (written by sealup init).',
    `# Secrets go through env:, never as inputs: sealup.yml reads them as $\{NAME}.`,
    'name: Deploy',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    '# One deploy at a time: a newer push waits, and a running deploy is never cancelled.',
    'concurrency:',
    `  group: sealup-${environmentName}`,
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    environment:',
    `      name: ${environmentName}`,
    `      url: $\{{ steps.sealup.outputs.url }}`,
    '    steps:',
    `      - uses: ${checkoutPin}`,
    '        with:',
    '          persist-credentials: false',
    '',
    ...(build === undefined
      ? []
      : [
          `      - uses: ${setupNodePin}`,
          '        with:',
          `          ${node}`,
          '',
          '      - name: Build',
          ...workingDirectory('        '),
          `        run: ${build.install} && ${build.run}`,
          '',
        ]),
    // sealup's own step by its version tag (0043): immutable releases lock the tag. The steps
    // above keep their full-SHA pins, since nothing locks their tags.
    `      - uses: sealup/sealup@v${options.version}`,
    '        id: sealup',
    ...(fromRepoRoot === '' ? [] : ['        with:', ...workingDirectory('          ')]),
    '        env:',
    ...(options.variables ?? [passwordVariable]).map(
      (name) => `          ${name}: $\{{ secrets.${name} }}`,
    ),
    '',
  ];
  return lines.join('\n');
}

/** A YAML string on one line: plain when it is plainly safe, else double-quoted (JSON's form). */
function yamlString(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : JSON.stringify(value);
}

/** What init writes: built by cli from the answers (or, in #37, from a sam-sync config). */
export interface InitPlan {
  readonly project: Project;
  /** sealup.yml's text (config's newConfigText). */
  readonly config: string;
  /**
   * The variables for sealup.env, in order, each a Secret from config's envSecret (its variable
   * is its envName): the password (absent without a terminal, or when sealup.env has one) and,
   * from a sam-sync conversion, the content of each file written from a secret; or an EnvValue:
   * a public repository's server and host key (0045).
   */
  readonly env: readonly (Secret | EnvValue)[];
  /** sealup's version: the sealup step's tag. */
  readonly version: string;
  /** The variables the workflow's sealup step gets from secrets (default: the password's). */
  readonly variables?: readonly string[];
}

/** A file init wrote or left, absolute. */
export interface InitFile {
  readonly path: string;
  readonly kind: 'config' | 'env' | 'gitignore' | 'workflow';
  /** `added`: a new file; `changed`: a line added to it; `left`: there already, untouched. */
  readonly change: 'added' | 'changed' | 'left';
  /** sealup.env: the variables added to it, in order. */
  readonly variables?: readonly string[];
}

/**
 * Writes the plan's files, sealup.yml first and exclusively: one already there is the problem
 * `config-exists` (exit 2), with nothing written. The files in the order written.
 */
export async function writeProject(
  plan: InitPlan,
): Promise<{ readonly files: readonly InitFile[] } | { readonly problem: Problem }> {
  const { project } = plan;
  const configFile = join(project.folder, 'sealup.yml');
  if (project.existingConfig !== undefined) {
    return { problem: { code: 'config-exists', file: project.existingConfig } };
  }
  try {
    await writeFile(configFile, plan.config, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { problem: { code: 'config-exists', file: configFile } };
  }
  const files: InitFile[] = [{ path: configFile, kind: 'config', change: 'added' }];
  if (plan.env.length > 0) {
    files.push(await writeEnv(join(project.folder, 'sealup.env'), plan.env));
  }
  const gitignore = await addIgnoreLine(join(project.folder, '.gitignore'));
  if (gitignore !== undefined) files.push(gitignore);
  files.push(await writeWorkflow(plan));
  return { files };
}

/**
 * sealup.env: created with mode 0600, or each variable it lacks appended and the file then set to
 * mode 0600 (R17: a file that holds secrets is its owner's alone; where the system has modes).
 */
async function writeEnv(
  file: string,
  variables: readonly (Secret | EnvValue)[],
): Promise<InitFile> {
  const before = await readText(file);
  let text = before ?? '';
  const added: string[] = [];
  for (const secret of variables) {
    const edit = withEnvVariable(text, secret);
    if (!edit.ok) {
      throw new RangeError(`${secret.envName} cannot go in sealup.env: ${edit.reason}`);
    }
    text = edit.text;
    if (edit.added) added.push(secret.envName);
  }
  if (before === undefined) {
    await writeFile(file, text, { flag: 'wx', mode: 0o600 });
    return { path: file, kind: 'env', change: 'added', variables: added };
  }
  if (added.length === 0) return { path: file, kind: 'env', change: 'left' };
  await chmod(file, 0o600);
  await appendFile(file, text.slice(before.length));
  return { path: file, kind: 'env', change: 'changed', variables: added };
}

/** The `sealup.env` line in .gitignore: the file made when missing, the line added once. */
async function addIgnoreLine(file: string): Promise<InitFile | undefined> {
  const before = await readText(file);
  if (before === undefined) {
    await writeFile(file, 'sealup.env\n', { flag: 'wx' });
    return { path: file, kind: 'gitignore', change: 'added' };
  }
  const lines = before.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes('sealup.env') || lines.includes('/sealup.env')) return undefined;
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const start = before === '' || before.endsWith('\n') ? '' : eol;
  await appendFile(file, `${start}sealup.env${eol}`);
  return { path: file, kind: 'gitignore', change: 'changed' };
}

/** The workflow, created exclusively: one already there is left as it is. */
async function writeWorkflow(plan: InitPlan): Promise<InitFile> {
  const { project } = plan;
  const file = project.workflow.file;
  const text = workflowText({
    version: plan.version,
    ...(project.build === undefined ? {} : { build: project.build }),
    ...(project.nodeVersionFile === undefined ? {} : { nodeVersionFile: project.nodeVersionFile }),
    fromRepoRoot: project.fromRepoRoot,
    ...(plan.variables === undefined ? {} : { variables: plan.variables }),
  });
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { path: file, kind: 'workflow', change: 'left' };
  }
  return { path: file, kind: 'workflow', change: 'added' };
}

/** A sam-sync project, read for the conversion (#37): its files, converted, and what it needs. */
export interface SamSyncProject {
  /** The sam-sync files read, from the project folder: the deployment file, the download file. */
  readonly files: readonly string[];
  readonly result: SamSyncResult;
  /**
   * The content of each file written from a secret, by its variable, made a Secret as it is read
   * (or why sealup.env cannot hold it); undefined when the local file is not there. Its line
   * breaks are read as LF: an env file holds no CR.
   */
  readonly contents: ReadonlyMap<string, EnvSecret | undefined>;
  /** The package.json scripts that call sam-sync, by name. */
  readonly scripts: readonly string[];
}

/**
 * Reads a sam-sync file (`file`, from the project folder) and its download file beside it, the
 * same name with `download` for `deployment` (`.download.json`), when there is one; converts
 * them; reads the content of each file to be written from a secret, and package.json's scripts.
 */
export async function readSamSync(folder: string, file: string): Promise<SamSyncProject> {
  const fromProject = (path: string) => relative(folder, path).split(sep).join('/');
  const deploymentPath = resolve(folder, file);
  const deployment = { name: fromProject(deploymentPath), text: await readText(deploymentPath) };
  const downloadName = basename(deploymentPath).replace('deployment', 'download');
  const downloadPath = join(dirname(deploymentPath), downloadName);
  const download =
    downloadName === basename(deploymentPath)
      ? undefined
      : { name: fromProject(downloadPath), text: await readText(downloadPath) };
  const read =
    download?.text === undefined ? undefined : { name: download.name, text: download.text };
  const files = [deployment.name, ...(read === undefined ? [] : [read.name])];
  const scripts = await samSyncScripts(folder);
  if (deployment.text === undefined) {
    return {
      files,
      result: { ok: false, problem: 'unreadable', file: deployment.name },
      contents: new Map(),
      scripts,
    };
  }
  const result = convertSamSync({
    deployment: { name: deployment.name, text: deployment.text },
    ...(read === undefined ? {} : { download: read }),
  });
  const contents = new Map<string, EnvSecret | undefined>();
  if (result.ok) {
    for (const { local, variable } of result.conversion.write) {
      const text = await readText(join(folder, ...local.split('/')));
      const content = text?.replaceAll('\r\n', '\n');
      contents.set(
        variable,
        content === undefined ? undefined : envSecret(variable, content, 'file'),
      );
    }
  }
  return { files, result, contents, scripts };
}

/** The names of package.json's scripts that call sam-sync. */
async function samSyncScripts(folder: string): Promise<string[]> {
  const text = await readText(join(folder, 'package.json'));
  if (text === undefined) return [];
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (typeof scripts !== 'object' || scripts === null) return [];
  return Object.entries(scripts)
    .filter(([, run]) => typeof run === 'string' && /\bsam-sync\b/.test(run))
    .map(([name]) => name);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
