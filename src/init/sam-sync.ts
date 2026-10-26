// The sam-sync conversion (spec #24 decision 22, S03; 0023 §9, I-053): a sam-sync
// `.deployment.json`, and its `.download.json` when there is one, turned into the facts of one
// sealup.yml. Pure: no node: import (paths
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
// folders become `upload`; rsync's excludes stay scoped to each source folder. Every single
// file becomes a direct upload; .env* source paths are recorded for .gitignore, never read or
// snapshotted into sealup.env. Repeated sources retain their destinations. `down` entries,
// of either file when on the same
// server, become `pull:`. What sealup.yml cannot hold is left out and said, never guessed.

import {
  type EnvSecret,
  envSecret,
  type NewConfig,
  newConfigText,
  passwordVariable,
} from '../config/index.ts';
import { inCommandSet, isWithin, normalizePath } from '../paths/index.ts';

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
  /** An exact redundant upload or a repeated server side of a pull. */
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
    readonly exclude?: readonly string[];
  }[];
  /** Directly uploaded .env* files, whose source paths must be ignored by Git. */
  readonly envFiles: readonly string[];
  readonly pull: readonly {
    readonly remote: string;
    readonly local: string;
    readonly kind: 'folder' | 'file';
  }[];
  /** `verbose` and `dry`, when the files set them: sealup has -v and --dry-run. */
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

  const upload: {
    local: string;
    remote: string;
    kind: 'folder' | 'file';
    exclude?: readonly string[];
  }[] = [];
  const envFiles = new Set<string>();
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
    const exclude = (entry.excludes ?? []).map((pattern) =>
      pattern.startsWith('/') ? pattern : `**/${pattern}`,
    );
    const identity = JSON.stringify([from, to, 'folder', exclude]);
    if (sent.has(identity)) {
      leave(entry.source, entry.destin ?? entry.source, 'twice');
      continue;
    }
    sent.add(identity);
    upload.push({
      local: from,
      remote: to,
      kind: 'folder',
      ...(exclude.length ? { exclude } : {}),
    });
  }
  for (const entry of deploy.up.files) {
    const from = local(deploy, deployBase, entry.source);
    const to = remote(deploy, entry.destin ?? entry.source);
    if (from === undefined || from === '' || to === undefined || to === '.') {
      leave(entry.source, entry.destin ?? entry.source, 'outside');
      continue;
    }
    if (from.slice(from.lastIndexOf('/') + 1).startsWith('.env')) {
      envFiles.add(from);
    }
    const identity = JSON.stringify([from, to, 'file']);
    if (sent.has(identity)) {
      leave(entry.source, entry.destin ?? entry.source, 'twice');
      continue;
    }
    sent.add(identity);
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
      envFiles: [...envFiles],
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

/** What the converted sealup.yml adds to the conversion. */
interface ConvertedOptions {
  /** The host key, once saved; else the placeholder. */
  readonly hostKey?: string;
  /** A public repository (0045): the server and the host key as references. */
  readonly publicRepo?: boolean;
}

/** The facts of sealup.yml for newConfigText: the conversion, and its options. */
function convertedConfig(
  conversion: SamSyncConversion,
  { hostKey, publicRepo }: ConvertedOptions,
): NewConfig {
  type Destination = string | { readonly to: string; readonly exclude: readonly string[] };
  const uploads = new Map<string, Destination[]>();
  for (const { local, remote, exclude } of conversion.upload) {
    const entries = uploads.get(local) ?? [];
    entries.push(exclude === undefined ? remote : { to: remote, exclude });
    uploads.set(local, entries);
  }
  return {
    server: conversion.server,
    ...(hostKey === undefined ? {} : { hostKey }),
    ...(publicRepo === true ? { publicRepo } : {}),
    upload: [...uploads].map(([local, entries]) => [
      local,
      entries.length === 1 ? (entries[0] ?? entries) : entries,
    ]),
    pull: conversion.pull.map(({ remote, local }) => [remote, local] as const),
  };
}

/**
 * sealup.yml's text for the conversion, with the host key once saved (else the placeholder);
 * `publicRepo`: the server and the host key as references (0045).
 */
export function convertedConfigText(
  conversion: SamSyncConversion,
  options: ConvertedOptions = {},
): string {
  return newConfigText(convertedConfig(conversion, options));
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
  if (path.startsWith('/') || /\p{Cc}/u.test(path)) return undefined;
  return normalizePath(path);
}

/** The folder of a `/`-separated path from the project folder: `.` for a name alone. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash) || '/';
}
