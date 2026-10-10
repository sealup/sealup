// The sam-sync conversion (spec #24 decision 22, S03; 0023 §9, I-053): a sam-sync
// `.deployment.json`, and its `.download.json` when there is one, turned into the facts of one
// sealup.yml. Undocumented: no help text or docs page names it. Pure: no node: import (paths
// reads every path, R10); in the import rules' pure list.
//
// sam-sync's format, from its own published package (sam-sync 1.1.1 on npm, index.js and
// .deployment.example.json, read 2026-10-08): `host`, `user`, `password`, `port` (default 22),
// `type` (`sftp` and `ftp` go through rclone; anything else is rsync and scp over SSH),
// `localPrefix` (from the file's folder) and `remotePrefix` (on the server), each put in front of
// an entry's path as text; `up` and `down`, each with `directories` (`source`, `destin` defaulting
// to `source`, rsync's `excludes`) and `files` (`source`, `destin`); `verbose` and `dry`.
//
// The rules: the server becomes an sftp:// URL for `sftp`, an ssh:// URL for rsync over SSH
// (0034), an ftp:// URL for `ftp` (spec #41 decision 18: S23's warning on its first run); `up`
// folders become `upload`; rsync's excludes, written
// from each folder, become .gitignore patterns from the config folder; a single file whose local name starts with
// `.env` becomes a `write` entry from a variable (`APP_ENV`), its content for sealup.env; other
// single files become single-file uploads; `down` entries, of either file when on the same
// server, become `pull:`. What sealup.yml cannot hold is left out and said, never guessed.

import {
  type EnvSecret,
  envSecret,
  type NewConfig,
  newConfigText,
  passwordVariable,
} from '../config/index.ts';
import { excludeMatcher, inCommandSet, isWithin, normalizePath } from '../paths/index.ts';

/** One sam-sync file: its path from the project folder (`/`-separated) and its text. */
export interface SamSyncFile {
  readonly name: string;
  readonly text: string;
}

/** Why an entry of the sam-sync files is not in sealup.yml. */
type LeftOutReason =
  /** Its local side is outside the project folder, or its server side outside the target folder. */
  | 'outside'
  /** It uploads the project folder itself (it would send sealup.env), or pulls into it. */
  | 'project-folder'
  /** A single file its folder's excludes leave out: sealup never sends an excluded file. */
  | 'excluded'
  /** The same local (upload) or server (pull) side as an entry before it. */
  | 'twice';

export interface SamSyncConversion {
  /** The sftp://, ssh:// or ftp:// URL, as sealup.yml holds it. */
  readonly server: string;
  /** The host, for the next commands. */
  readonly host: string;
  /**
   * The password, made a Secret as it is read (or why sealup.env cannot hold it), for sealup.env;
   * absent when the file has none.
   */
  readonly password?: EnvSecret;
  readonly upload: readonly {
    readonly local: string;
    readonly remote: string;
    readonly kind: 'folder' | 'file';
  }[];
  readonly exclude: readonly string[];
  /** Files written from a secret: the local file whose content goes to sealup.env. */
  readonly write: readonly {
    readonly local: string;
    readonly remote: string;
    readonly variable: string;
  }[];
  readonly pull: readonly {
    readonly remote: string;
    readonly local: string;
    readonly kind: 'folder' | 'file';
  }[];
  /** `verbose` and `dry`, when the files set them: sealup has -v and -n. */
  readonly dropped: readonly ('verbose' | 'dry')[];
  /** The `.download.json`: on the same server (its entries are pulls), or another (skipped). */
  readonly download?: 'same' | 'other';
  /** rsync's excludes of pulled folders: sealup pull has none. */
  readonly pullExcludes: readonly string[];
  readonly leftOut: readonly {
    readonly from: string;
    readonly to: string;
    readonly reason: LeftOutReason;
  }[];
}

export type SamSyncResult =
  | { readonly ok: true; readonly conversion: SamSyncConversion }
  /** Not sam-sync's JSON (`file` names which). */
  | { readonly ok: false; readonly problem: 'unreadable'; readonly file: string };

interface Entry {
  readonly source: string;
  readonly destin?: string;
  readonly excludes?: readonly string[];
}

interface SamSyncConfig {
  readonly type?: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly password?: string;
  readonly localPrefix: string;
  readonly remotePrefix: string;
  readonly verbose?: unknown;
  readonly dry?: unknown;
  readonly up: { readonly directories: readonly Entry[]; readonly files: readonly Entry[] };
  readonly down: { readonly directories: readonly Entry[]; readonly files: readonly Entry[] };
}

/** The variable a file written from a secret reads, by its order: APP_ENV, APP_ENV_2, … */
const envVariable = (index: number): string => (index === 0 ? 'APP_ENV' : `APP_ENV_${index + 1}`);

export function convertSamSync(files: {
  readonly deployment: SamSyncFile;
  readonly download?: SamSyncFile;
}): SamSyncResult {
  const deploy = readSamSync(files.deployment.text);
  if (deploy === undefined)
    return { ok: false, problem: 'unreadable', file: files.deployment.name };
  const down = files.download === undefined ? undefined : readSamSync(files.download.text);
  if (files.download !== undefined && down === undefined) {
    return { ok: false, problem: 'unreadable', file: files.download.name };
  }
  const target = serverFolder(deploy.remotePrefix);
  const port = deploy.port === defaultPort(deploy.type) ? '' : `:${deploy.port}`;
  const leftOut: { from: string; to: string; reason: LeftOutReason }[] = [];
  const leave = (from: string, to: string, reason: LeftOutReason) =>
    leftOut.push({ from, to, reason });

  const local = (config: SamSyncConfig, base: string, path: string): string | undefined =>
    projectPath(`${base}/${config.localPrefix.replace(/^\/+/, '')}${path}`);
  const remote = (config: SamSyncConfig, path: string): string | undefined => {
    const folder = serverFolder(config.remotePrefix);
    const full = normalizePath(`${folder.path}/${folder.rest}${path}`) ?? '/';
    if (full === target.path) return '.';
    if (!isWithin(full, target.path)) return undefined;
    return full.slice(target.path === '/' ? 1 : target.path.length + 1);
  };
  const deployBase = folderOf(files.deployment.name);

  const upload: { local: string; remote: string; kind: 'folder' | 'file' }[] = [];
  const exclude: string[] = [];
  const write: { local: string; remote: string; variable: string }[] = [];
  const singles: { local: string; remote: string }[] = [];
  const sent = new Set<string>();
  for (const entry of deploy.up.directories) {
    const from = local(deploy, deployBase, entry.source);
    const to = remote(deploy, entry.destin ?? entry.source);
    if (from === undefined || to === undefined) {
      leave(entry.source, entry.destin ?? entry.source, 'outside');
      continue;
    }
    if (from === '') {
      leave(entry.source, entry.destin ?? entry.source, 'project-folder');
      continue;
    }
    if (sent.has(from)) {
      leave(entry.source, entry.destin ?? entry.source, 'twice');
      continue;
    }
    sent.add(from);
    upload.push({ local: from, remote: to, kind: 'folder' });
    exclude.push(...(entry.excludes ?? []).map((pattern) => gitignorePattern(from, pattern)));
  }
  const excluded = excludeMatcher(exclude);
  for (const entry of deploy.up.files) {
    const from = local(deploy, deployBase, entry.source);
    const to = remote(deploy, entry.destin ?? entry.source);
    if (from === undefined || from === '' || to === undefined || to === '.') {
      leave(entry.source, entry.destin ?? entry.source, 'outside');
      continue;
    }
    if (from.slice(from.lastIndexOf('/') + 1).startsWith('.env')) {
      write.push({ local: from, remote: to, variable: envVariable(write.length) });
      continue;
    }
    if (excluded(from)) {
      leave(entry.source, entry.destin ?? entry.source, 'excluded');
      continue;
    }
    if (sent.has(from)) {
      leave(entry.source, entry.destin ?? entry.source, 'twice');
      continue;
    }
    sent.add(from);
    singles.push({ local: from, remote: to });
  }
  upload.push(...singles.map((single) => ({ ...single, kind: 'file' as const })));

  const sameServer =
    down !== undefined &&
    (down.type === 'ftp') === (deploy.type === 'ftp') &&
    down.host === deploy.host &&
    down.user === deploy.user &&
    down.port === deploy.port;
  const pull: { remote: string; local: string; kind: 'folder' | 'file' }[] = [];
  const pullExcludes: string[] = [];
  const pulled = new Set<string>();
  const downloadBase = files.download === undefined ? deployBase : folderOf(files.download.name);
  const pulls: [SamSyncConfig, string][] = [
    [deploy, deployBase],
    ...(sameServer ? ([[down, downloadBase]] as [SamSyncConfig, string][]) : []),
  ];
  for (const [config, base] of pulls) {
    for (const kind of ['folder', 'file'] as const) {
      for (const entry of config.down[kind === 'folder' ? 'directories' : 'files']) {
        const from = remote(config, entry.source);
        const to = local(config, base, entry.destin ?? entry.source);
        if (from === undefined || to === undefined || (kind === 'file' && from === '.')) {
          leave(entry.source, entry.destin ?? entry.source, 'outside');
          continue;
        }
        if (to === '') {
          leave(entry.source, entry.destin ?? entry.source, 'project-folder');
          continue;
        }
        if (pulled.has(from)) {
          leave(entry.source, entry.destin ?? entry.source, 'twice');
          continue;
        }
        pulled.add(from);
        pull.push({ remote: from, local: to, kind });
        pullExcludes.push(...(entry.excludes ?? []));
      }
    }
  }

  const dropped = (['verbose', 'dry'] as const).filter(
    (key) => deploy[key] !== undefined || (sameServer && down?.[key] !== undefined),
  );
  return {
    ok: true,
    conversion: {
      server: `${scheme(deploy.type, target.path)}://${deploy.user}@${deploy.host}${port}${target.path}`,
      host: deploy.host,
      ...(deploy.password === undefined || deploy.password === ''
        ? {}
        : { password: envSecret(passwordVariable, deploy.password) }),
      upload,
      exclude,
      write,
      pull,
      dropped,
      ...(down === undefined ? {} : { download: sameServer ? 'same' : 'other' }),
      pullExcludes,
      leftOut,
    },
  };
}

/**
 * sftp:// for sam-sync's `sftp` (rclone over SFTP); ssh:// for rsync and scp over SSH (no type, or
 * any other), which need a shell: changed files then travel as one archive (0034). A folder no
 * remote command may hold (R15) keeps sftp://, which takes it.
 */
function scheme(type: string | undefined, folder: string): 'sftp' | 'ssh' | 'ftp' {
  if (type === 'ftp') return 'ftp';
  return type === 'sftp' || !inCommandSet(folder) ? 'sftp' : 'ssh';
}

/** The port a URL of that type leaves out: FTP's 21, SSH's 22 (spec #41 decision 10). */
function defaultPort(type: string | undefined): number {
  return type === 'ftp' ? 21 : 22;
}

/** The facts of sealup.yml for newConfigText: the conversion, and the host key once saved. */
function convertedConfig(conversion: SamSyncConversion, hostKey?: string): NewConfig {
  return {
    server: conversion.server,
    ...(hostKey === undefined ? {} : { hostKey }),
    upload: conversion.upload.map(({ local, remote }) => [local, remote] as const),
    exclude: conversion.exclude,
    write: conversion.write.map(({ remote, variable }) => [remote, variable] as const),
    pull: conversion.pull.map(({ remote, local }) => [remote, local] as const),
  };
}

/** sealup.yml's text for the conversion, with the host key once saved (else the placeholder). */
export function convertedConfigText(conversion: SamSyncConversion, hostKey?: string): string {
  return newConfigText(convertedConfig(conversion, hostKey));
}

/** sam-sync's JSON, or undefined when the text is not one sealup can read. */
function readSamSync(text: string): SamSyncConfig | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(json)) return undefined;
  const { type, host, user, port, password, localPrefix, remotePrefix } = json;
  if (typeof host !== 'string' || host === '' || typeof user !== 'string' || user === '') {
    return undefined;
  }
  if (port !== undefined && !(Number.isInteger(port) && (port as number) > 0)) return undefined;
  const optionalText = [type, password, localPrefix, remotePrefix];
  if (optionalText.some((value) => value !== undefined && typeof value !== 'string')) {
    return undefined;
  }
  const up = section(json.up);
  const down = section(json.down);
  if (up === undefined || down === undefined) return undefined;
  return {
    ...(type === undefined ? {} : { type: type as string }),
    host,
    user,
    // sam-sync's default is 22; its plain FTP goes to FTP's own port unless the file names one.
    port: (port as number | undefined) ?? defaultPort(type as string | undefined),
    ...(password === undefined ? {} : { password: password as string }),
    localPrefix: (localPrefix as string | undefined) ?? '',
    remotePrefix: (remotePrefix as string | undefined) ?? '',
    verbose: json.verbose,
    dry: json.dry,
    up,
    down,
  };
}

function section(value: unknown): SamSyncConfig['up'] | undefined {
  if (value === undefined) return { directories: [], files: [] };
  if (!isObject(value)) return undefined;
  const directories = entries(value.directories);
  const files = entries(value.files);
  return directories === undefined || files === undefined ? undefined : { directories, files };
}

function entries(value: unknown): Entry[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const read: Entry[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.source !== 'string') return undefined;
    const { source, destin, excludes } = item;
    if (destin !== undefined && typeof destin !== 'string') return undefined;
    if (
      excludes !== undefined &&
      !(Array.isArray(excludes) && excludes.every((pattern) => typeof pattern === 'string'))
    ) {
      return undefined;
    }
    read.push({
      source,
      ...(destin === undefined ? {} : { destin }),
      ...(excludes === undefined ? {} : { excludes: excludes as string[] }),
    });
  }
  return read;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The server folder of a `remotePrefix`: sam-sync puts the prefix in front of each path as text,
 * so the folder ends at its last `/` and what follows (`rest`) starts every path. A relative
 * prefix is from the login folder (`/~/…` in the URL), as rsync and scp read `host:path`.
 * `path` is the folder as the server URL writes it, normalized (paths' normalizePath), so
 * paths' isWithin compares it segment by segment.
 */
function serverFolder(prefix: string): { readonly path: string; readonly rest: string } {
  const cut = prefix.lastIndexOf('/') + 1;
  const rest = prefix.slice(cut);
  const folder = prefix.slice(0, cut).replace(/^~(\/|$)/, '');
  // An absolute path never climbs out (a `..` at the root stays there): never undefined.
  if (folder.startsWith('/')) return { path: normalizePath(folder) ?? '/', rest };
  const inside = normalizePath(`/${folder}`) ?? '/';
  return { path: inside === '/' ? '/~' : `/~${inside}`, rest };
}

/**
 * A local path from the project folder, `/`-separated, without a last `/`; `''` for the project
 * folder itself; undefined outside it (R10, paths' normalizePath: segment by segment).
 */
function projectPath(path: string): string | undefined {
  if (path.startsWith('/')) return undefined;
  return normalizePath(path);
}

/** The folder of a `/`-separated path from the project folder: `.` for a name alone. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash) || '/';
}

/**
 * One of rsync's `--exclude` patterns of a folder, as a .gitignore pattern from the config
 * folder: `/x` is anchored to the folder (`folder/x`); a pattern without a leading `/` matches
 * at any depth below it (`folder/**\/x`); a last `/` (folders only) is kept.
 */
function gitignorePattern(folder: string, pattern: string): string {
  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.replace(/^\/+/, '') : pattern;
  return anchored ? `${folder}/${body}` : `${folder}/**/${body}`;
}
