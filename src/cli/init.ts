// `sealup init` (S02, spec #24 decisions 19-21): the questions and their order. init (the module)
// reads the project and writes its files; report words the screen; this file asks.
//
// On a terminal (stdin and stderr both): what was found, the upload folder when none was, the
// server address (unless --server), the host key shown as keyscan shows it and saved on a yes,
// then the password, hidden, into sealup.env. Without a terminal it needs --server, never
// connects, never trusts a key (the placeholder comment instead) and writes no sealup.env.
// Esc or Ctrl-C at a question: exit 130, nothing written. Files are written only at the end.
//
// The sam-sync conversion (#37, S03, spec #24 decision 22; undocumented): after the
// existing-config check, a `.deployment.json` on a terminal is offered for conversion (a no goes
// on with S02's questions); `--from <file>` converts without asking, and without a terminal too.
// The converted sealup.yml takes the host-key step below (the placeholder without a terminal);
// the password and each file written from a secret go to sealup.env. Nothing is deleted.

import { join, relative, sep } from 'node:path';
import { envSecret, newConfigText, parseServerUrl, passwordVariable } from '../config/index.ts';
import {
  ExitCode,
  isFtp,
  type Problem,
  type ScanHostKey,
  type Secret,
  type ServerUrl,
} from '../contracts/index.ts';
import {
  convertedConfigText,
  type InitFile,
  type Project,
  readProject,
  readSamSync,
  type SamSyncProject,
  writeProject,
} from '../init/index.ts';
import { scanKey } from '../keyscan/index.ts';
import { folderInside } from '../paths/index.ts';
import {
  createPromptView,
  type Form,
  type InitStep,
  type Out,
  printInit,
  printInitJson,
  printKeyscan,
} from '../report/index.ts';
import { createPrompts, type Keyboard, type Prompts } from './prompts.ts';

/** How long the host-key scan may take (the default `timeout` of a target, 0022). */
const scanTimeoutMs = 30_000;

/** What init needs from main(): the run's streams, its form, and how a problem is reported. */
export interface InitContext {
  readonly cwd: string;
  /** Questions are asked: stdin and stderr are both terminals. */
  readonly terminal: boolean;
  readonly keyboard: Keyboard;
  readonly scanHostKey: ScanHostKey;
  readonly signal: AbortSignal | undefined;
  readonly out: Out;
  readonly form: Form;
  readonly version: string;
  /** The release commit's SHA, when the bundle carries it: the workflow's sealup pin. */
  readonly releaseSha: string | undefined;
  /** `--server`, as typed. */
  readonly server: string | undefined;
  /** `--from`, as typed: a sam-sync config to convert (undocumented). */
  readonly from: string | undefined;
  /** Where `--json` writes its object, when asked for. */
  readonly json: { readonly write: (text: string) => unknown } | undefined;
  /** Reports a problem as main() does, and gives its exit code. */
  readonly stop: (problem: Problem) => number;
  /**
   * The log's first lines, GitHub's masks of `secrets` first (R2): called once the secrets init
   * reads are known, before init prints anything. A later call does nothing.
   */
  readonly begin: (secrets: readonly Secret[]) => void;
}

/** The run's questions, made on the first one (one Prompts per run: typed-ahead keys carry). */
interface Asking {
  readonly ask: () => Prompts;
  readonly cancelled: () => number;
}

export async function initCommand(context: InitContext): Promise<number> {
  const { out, form, terminal, stop } = context;
  const show = (step: InitStep) => printInit(out, form, step);
  const project = await readProject(context.cwd);
  if (project.existingConfig !== undefined) {
    return stop({ code: 'config-exists', file: project.existingConfig });
  }
  if (context.from !== undefined && context.server !== undefined) {
    return stop({ code: 'usage', reason: 'from-and-server' });
  }
  let prompts: Prompts | undefined;
  const asking: Asking = {
    ask: () => {
      prompts ??= createPrompts(context.keyboard, createPromptView(out), context.signal);
      return prompts;
    },
    cancelled: () => stop({ code: 'cancelled', picker: false }),
  };
  const { ask, cancelled } = asking;

  const offered = terminal && context.server === undefined && project.deploymentJson;
  const samSync =
    context.from !== undefined || offered
      ? await readSamSync(context.cwd, context.from ?? '.deployment.json')
      : undefined;
  // The secrets the sam-sync files hold are masked before any other byte (R2): `--from` runs
  // without a terminal, so in GitHub's form too.
  context.begin(samSync === undefined ? [] : samSyncSecrets(samSync));
  if (samSync !== undefined) {
    if (context.from !== undefined) return convert(context, project, samSync, asking);
    show({ kind: 'sam-sync-found', files: samSync.files });
    const yes = await ask().yesNo('  Convert it to sealup.yml?', true);
    if (yes === undefined) return cancelled();
    out.write('\n');
    if (yes) return convert(context, project, samSync, asking);
  }

  if (!terminal && context.server === undefined) {
    return stop({ code: 'no-terminal', deploymentJson: project.deploymentJson });
  }
  let server: { readonly text: string; readonly url: ServerUrl } | undefined;
  if (context.server !== undefined) {
    const read = readServer(context.server);
    if (read === undefined) {
      return stop({ code: 'usage', reason: 'bad-server-address', name: '--server' });
    }
    server = read;
  }

  show({
    kind: 'project',
    upload:
      project.upload !== undefined
        ? { found: project.upload.folder, files: project.upload.files }
        : terminal
          ? { asked: true }
          : { assumed: 'dist' },
    ...(project.build === undefined ? {} : { build: project.build.run }),
  });
  let upload = project.upload?.folder ?? 'dist';
  if (project.upload === undefined && terminal) {
    out.write('\n');
    for (;;) {
      const answer = await ask().text('  Folder to upload:');
      if (answer === undefined) return cancelled();
      const folder = folderInside(answer);
      if (folder !== undefined) {
        upload = folder;
        break;
      }
      show({ kind: 'upload-refused' });
    }
  }

  if (server === undefined) {
    out.write('\n');
    show({ kind: 'server-intro' });
    while (server === undefined) {
      const answer = await ask().text('  Server address:');
      if (answer === undefined) return cancelled();
      const read = readServer(answer.trim());
      if (read === undefined) show({ kind: 'server-refused' });
      else server = read;
    }
  }

  let hostKey: string | undefined;
  let password: Secret | undefined;
  if (terminal) {
    out.write('\n');
    const key = await askHostKey(context, server.url, asking);
    if (typeof key === 'number') return key;
    hostKey = key.line;
    const typed = await askPassword(context, project, server.url, asking);
    if (typeof typed === 'number') return typed;
    password = typed.password;
  }

  const written = await writeProject({
    project,
    config: newConfigText({
      server: server.text,
      upload,
      ...(hostKey === undefined ? {} : { hostKey }),
    }),
    env: password === undefined ? [] : [password],
    version: context.version,
    releaseSha: context.releaseSha,
  });
  if ('problem' in written) return stop(written.problem);
  return done(context, written.files, {
    kind: 'done',
    files: [],
    upload,
    build: project.build !== undefined,
    hostKey: noHostKey(server.url) ? 'none' : hostKey !== undefined,
    host: server.url.host,
    terminal,
  });
}

/**
 * The sam-sync conversion (S03): what was converted, the host key (on a terminal), the password
 * asked only when the files hold none sealup can use, then the files.
 */
async function convert(
  context: InitContext,
  project: Project,
  samSync: SamSyncProject,
  asking: Asking,
): Promise<number> {
  const { out, form, terminal, stop } = context;
  const show = (step: InitStep) => printInit(out, form, step);
  const { result } = samSync;
  if (!result.ok) return stop({ code: 'usage', reason: 'not-sam-sync', name: result.file });
  const { conversion } = result;
  const server = readServer(conversion.server);
  if (server === undefined) {
    const [name = '.deployment.json'] = samSync.files;
    return stop({ code: 'usage', reason: 'not-sam-sync', name });
  }

  const env: Secret[] = [];
  const secrets: { name: string; from?: string }[] = [];
  const notMoved: Extract<InitStep, { kind: 'converted' }>['notMoved'][number][] = [];
  let passwordAsked = false;
  if (!project.envHasPassword) {
    const checked = conversion.password;
    if (checked?.ok === true) {
      env.push(checked.secret);
      secrets.push({ name: passwordVariable });
    } else {
      passwordAsked = terminal;
      if (checked !== undefined) {
        notMoved.push({ name: passwordVariable, reason: checked.reason });
      } else if (!terminal) {
        notMoved.push({ name: passwordVariable, reason: 'no-password' });
      }
    }
  }
  for (const { local, variable } of conversion.write) {
    const checked = samSync.contents.get(variable);
    if (checked?.ok === true) {
      env.push(checked.secret);
      secrets.push({ name: variable, from: local });
    } else {
      notMoved.push({
        name: variable,
        from: local,
        reason: checked === undefined ? 'missing' : checked.reason,
      });
    }
  }

  show({
    kind: 'converted',
    server: conversion.server,
    folders: conversion.upload.filter((entry) => entry.kind === 'folder'),
    exclude: conversion.exclude,
    files: [...conversion.write, ...conversion.upload.filter((entry) => entry.kind === 'file')],
    pulls: conversion.pull,
    secrets,
    notMoved,
    dropped: conversion.dropped,
    ...(conversion.download === undefined || samSync.files[1] === undefined
      ? {}
      : { download: { name: samSync.files[1], same: conversion.download === 'same' } }),
    pullExcludes: conversion.pullExcludes,
    leftOut: conversion.leftOut,
  });

  let hostKey: string | undefined;
  if (terminal) {
    out.write('\n');
    // sam-sync never checked the server's key; FTP and FTPS have none to check.
    if (!noHostKey(server.url)) {
      show({ kind: 'sam-sync-key' });
      out.write('\n');
    }
    const key = await askHostKey(context, server.url, asking);
    if (typeof key === 'number') return key;
    hostKey = key.line;
    if (passwordAsked) {
      const typed = await askPassword(context, project, server.url, asking);
      if (typeof typed === 'number') return typed;
      if (typed.password !== undefined) env.unshift(typed.password);
    }
  }

  const variables = [passwordVariable, ...conversion.write.map(({ variable }) => variable)];
  const written = await writeProject({
    project,
    config: convertedConfigText(conversion, hostKey),
    env,
    version: context.version,
    releaseSha: context.releaseSha,
    variables,
  });
  if ('problem' in written) return stop(written.problem);
  return done(context, written.files, {
    kind: 'done',
    files: [],
    upload: '',
    build: project.build !== undefined,
    hostKey: noHostKey(server.url) ? 'none' : hostKey !== undefined,
    host: server.url.host,
    terminal,
    secrets: variables,
    samSync: {
      files: samSync.files,
      scripts: samSync.scripts,
      pull: conversion.pull.length > 0,
      password: conversion.password !== undefined,
    },
  });
}

/** The end: the files written, from the current folder, and `--json`'s object. */
function done(
  context: InitContext,
  written: readonly InitFile[],
  step: Extract<InitStep, { kind: 'done' }>,
): number {
  const files = written.map((file) => ({
    ...file,
    path: relative(context.cwd, file.path).split(sep).join('/'),
  }));
  printInit(context.out, context.form, { ...step, files });
  if (context.json !== undefined) {
    const paths = files.filter((file) => file.change !== 'left').map((file) => file.path);
    printInitJson(context.json, context.version, paths);
  }
  return ExitCode.ok;
}

/**
 * The server's key, shown as keyscan shows it, and saved on a yes: the key line, undefined for
 * a no; or the exit code of a failed scan or a cancelled question.
 */
async function askHostKey(
  context: InitContext,
  url: ServerUrl,
  { ask, cancelled }: Asking,
): Promise<{ readonly line: string | undefined } | number> {
  const { out, form } = context;
  const configFile = join(context.cwd, 'sealup.yml');
  // The new sealup.yml's first line (newConfigText).
  const place = { file: configFile, keyPath: 'server', line: 1 };
  // FTPS has no host key: its certificate is checked at each connect, and `sealup keyscan` pins
  // it when the normal check fails (spec #41 decision 12). Nothing to scan here.
  if (url.protocol === 'ftps') return { line: undefined };
  printKeyscan(out, form, { kind: 'target', name: url.host, server: url });
  // Plain FTP has no key to scan or save (spec #41 decision 12).
  if (url.protocol === 'ftp') {
    printKeyscan(out, form, { kind: 'no-key', configFile, place });
    return { line: undefined };
  }
  const scanned = await scanKey(
    { name: url.host, configFile, server: url, place, timeoutMs: scanTimeoutMs },
    context.scanHostKey,
    context.signal,
  );
  if ('problem' in scanned) {
    printKeyscan(out, form, { kind: 'not-checked' });
    return context.stop(scanned.problem);
  }
  const { report } = scanned;
  printKeyscan(out, form, { kind: 'found', report, asking: true, where: 'log', again: [] });
  const yes = await ask().yesNo('  Save it to sealup.yml as hostKey?', false);
  if (yes === undefined) return cancelled();
  return { line: yes ? report.shown.line : undefined };
}

/**
 * The password, asked hidden until sealup can use it, made a Secret as soon as it is typed; none
 * asked when sealup.env holds one. The exit code of a cancelled question.
 */
async function askPassword(
  context: InitContext,
  project: Project,
  url: ServerUrl,
  { ask, cancelled }: Asking,
): Promise<{ readonly password: Secret | undefined } | number> {
  const show = (step: InitStep) => printInit(context.out, context.form, step);
  show({ kind: 'password-intro', kept: project.envHasPassword });
  if (project.envHasPassword) return { password: undefined };
  for (;;) {
    const answer = await ask().hidden(`  Password for ${url.user}@${url.host}:`);
    if (answer === undefined) return cancelled();
    const checked = envSecret(passwordVariable, answer);
    if (checked.ok) return { password: checked.secret };
    show({ kind: 'password-refused', reason: checked.reason });
  }
}

/** The secrets a sam-sync project holds that sealup can mask: its password, its files' contents. */
function samSyncSecrets(samSync: SamSyncProject): Secret[] {
  const made = [
    ...(samSync.result.ok ? [samSync.result.conversion.password] : []),
    ...samSync.contents.values(),
  ];
  return made.flatMap((checked) => (checked?.ok === true ? [checked.secret] : []));
}

/** A server address as typed, read as `server:` is; undefined when it is not a server URL. */
function readServer(text: string): { readonly text: string; readonly url: ServerUrl } | undefined {
  const parsed = parseServerUrl(text);
  return parsed.ok ? { text, url: parsed.url } : undefined;
}

/** A protocol with no host key to save: plain FTP, and FTPS, whose certificate stands for it. */
function noHostKey(url: ServerUrl): boolean {
  return isFtp(url.protocol);
}
