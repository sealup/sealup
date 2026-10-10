// One target of the file, resolved: its values filled in from the environment, its server URL,
// login (password, or private key and passphrase), host key, url, manifest folder, uploads, excludes, writes and pulls read, defaults
// applied. Its problems belong to it alone (an unset variable, a value that is wrong once filled
// in, a key not available yet): they stop only a run to this target. Whatever is wrong, it still
// tells its facts (the variables it read, its hostKey state, its url, host and server).

import { relative, resolve, sep } from 'node:path';
import {
  type AllowedRisk,
  type ConfigIssue,
  type ConfigPlace,
  type HostKey,
  isFtp,
  type Mapping,
  maxFtpConnections,
  type PullEntry,
  type RemotePath,
  type Secret,
  type ServerUrl,
  type Target,
  type VariableSource,
} from '../contracts/index.ts';
import { excludeMatcher, parseRemotePath, parseServerPath } from '../paths/index.ts';
import { createFileSecret, createSecret } from '../secret/index.ts';
import type { Env } from './env.ts';
import { isFile } from './find.ts';
import { parseHostKey } from './host-key.ts';
import { interpolate, referenceOf, variablesIn } from './interpolate.ts';
import { type Path, sorted } from './place.ts';
import { resolvePulls } from './pull.ts';
import {
  durationPattern,
  type PullInput,
  type TargetInput,
  type UploadInput,
  type WriteInput,
} from './schema.ts';
import { parseServerUrl } from './server-url.ts';
import { resolveWrites } from './write.ts';

/**
 * What a target's entry says even when it cannot be used (`sealup` alone, `check`): never a
 * value of a secret.
 */
interface TargetFacts {
  /** The variables its values read that are set, in the order read, each once. */
  readonly variables: readonly VariableSource[];
  /** How it logs in, as the file says (`check`, decision 0033), whether or not it resolved. */
  readonly login: 'password' | 'private-key';
  /**
   * `unknown`: its hostKey line is there but cannot be read (an issue says why). `none`: an
   * `ftp://` target, whose protocol has no host key.
   */
  readonly hostKey: 'saved' | 'missing' | 'unknown' | 'none';
  /** Its `url`, when it has one that resolved. */
  readonly url?: string;
  /** Its server's host, when the server URL resolved. */
  readonly host?: string;
  /**
   * Its `server` URL as written in the file (`${VAR}` left as it is), when it resolved: what
   * the target picker shows (S12). Never a refused `user:password@` URL (R3).
   */
  readonly server?: string;
  /** Its `pull` entries that resolved (`sealup` alone shows them, S05). */
  readonly pulls: readonly PullEntry[];
  /**
   * Where its server is, when the server URL resolved, whatever else is wrong (an unset
   * password): what `keyscan` needs, and all it reads (spec #24 decision 18).
   */
  readonly connection?: ServerFacts;
}

/** A target's server and its saved key, for `keyscan`: never its password. */
interface ServerFacts {
  readonly url: ServerUrl;
  readonly place: ConfigPlace;
  /** The saved key and its place; absent when the config has no `hostKey` for it. */
  readonly hostKey?: { readonly key: HostKey; readonly place: ConfigPlace };
  /** `ftps://`: the pinned certificate's SHA-256 and its place, when the config has one. */
  readonly tlsFingerprint?: { readonly sha256: string; readonly place: ConfigPlace };
  /** The target's `timeout`, ms: how long a scan may take. */
  readonly timeoutMs: number;
}

export type TargetResult = (
  | { readonly ok: true; readonly target: Target }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] }
) &
  TargetFacts;

const defaults = { parallel: 64, timeoutMs: 30_000, manifestFolder: '/~/.sealup' } as const;

/**
 * `parallel` on FTP counts connections (spec #41 decision 4): 4 by default, at most 16. SFTP's 64
 * is requests in flight over one connection.
 */
const ftpConnections = { default: 4, max: maxFtpConnections } as const;

/** `tlsFingerprint`: a SHA-256 as 32 colon-separated pairs of hex digits (either case). */
const fingerprintPattern = /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

/** The keys a target logs in with (decision 0033). */
const loginKeys = ['password', 'privateKey', 'passphrase'] as const;

export interface Context {
  /** The folder holding the config: local paths are relative to it. */
  readonly folder: string;
  readonly env: Env;
  readonly envFile: string;
  /** The variables whose value came from the env file. */
  readonly fromFile: ReadonlySet<string>;
  readonly place: (path: Path) => ConfigPlace;
  /** Every Secret made while loading (LoadedSecrets). */
  readonly secrets: Secret[];
}

export type ListItem = readonly [text: string, path: Path];

/** A target's lists, shared first, each value with its place. */
export interface Lists {
  readonly uploads: readonly (readonly [upload: UploadInput, path: Path])[];
  readonly exclude: readonly ListItem[];
  readonly writes: readonly (readonly [write: WriteInput, path: Path])[];
  readonly pulls: readonly (readonly [pull: PullInput, path: Path])[];
}

export async function resolveTarget(
  name: string,
  input: TargetInput,
  lists: Lists,
  pathOf: (key: string) => Path,
  context: Context,
): Promise<TargetResult> {
  const issues: ConfigIssue[] = [];
  const at = (key: string): ConfigPlace => context.place(pathOf(key));
  const variables = new Map<string, VariableSource>();
  /** The value with its variables filled in, or undefined after reporting the unset one. */
  const fill = (text: string, path: Path): string | undefined => {
    const filled = interpolate(text, context.env);
    if (filled.ok) {
      for (const name of variablesIn(text)) {
        const from = context.fromFile.has(name) ? 'env-file' : 'environment';
        if (!variables.has(name)) variables.set(name, { name, from });
      }
      return filled.value;
    }
    issues.push({
      code: 'variable-not-set',
      ...context.place(path),
      variable: filled.variable,
      ...(filled.message === undefined ? {} : { message: filled.message }),
      envFile: context.envFile,
    });
    return undefined;
  };

  let server: Target['server'] | undefined;
  const serverText = fill(input.server, pathOf('server'));
  if (serverText !== undefined) {
    const parsed = parseServerUrl(serverText);
    if (parsed.ok) server = parsed.url;
    else issues.push({ code: 'server-url', ...at('server') });
  }

  /**
   * A login key's Secret (decision 0033), or undefined when the config has none or after
   * reporting why it cannot be used. The syntax pass made sure it is one reference.
   */
  const credential = (
    key: (typeof loginKeys)[number],
    make: typeof createSecret,
  ): Secret | undefined => {
    const text = input[key];
    const reference = text === undefined ? undefined : referenceOf(text);
    if (text === undefined || reference === undefined) return undefined;
    const value = fill(text, pathOf(key));
    if (value === undefined) return undefined;
    const secret = make(reference.variable, value);
    if (secret.ok) {
      context.secrets.push(secret.secret);
      return secret.secret;
    }
    issues.push({
      code: 'secret-refused',
      ...at(key),
      variable: reference.variable,
      reason: secret.problem === 'too-short' ? 'too-short' : 'unsafe-character',
    });
    return undefined;
  };
  const password = credential('password', createSecret);
  // A key keeps its line breaks: they are its format, and it never travels as text (0033).
  const privateKey = credential('privateKey', createFileSecret);
  const passphrase = credential('passphrase', createSecret);

  // FTP and FTPS share their login and connection rules; the host key is SSH's only.
  const ftp = server !== undefined && isFtp(server.protocol);
  // FTP logs in with a password only: a key is SSH's (decision 0033).
  if (ftp && input.privateKey !== undefined) {
    issues.push({ code: 'login', ...at('privateKey'), detail: 'ftp-key' });
  }
  const parallel = input.parallel ?? (ftp ? ftpConnections.default : defaults.parallel);
  if (ftp && parallel > ftpConnections.max) {
    issues.push({ code: 'wrong-type', ...at('parallel'), expected: 'connections' });
  }

  let hostKey: Target['hostKey'];
  if (input.hostKey !== undefined) {
    const line = fill(input.hostKey, pathOf('hostKey'));
    if (line !== undefined) {
      hostKey = parseHostKey(line);
      if (hostKey === undefined) issues.push({ code: 'host-key', ...at('hostKey') });
    }
  }

  // The pinned certificate (R8), read for `ftps://` only, as hostKey is not for FTP.
  let tlsFingerprint: string | undefined;
  if (input.tlsFingerprint !== undefined && server?.protocol === 'ftps') {
    const value = fill(input.tlsFingerprint, pathOf('tlsFingerprint'));
    if (value !== undefined && fingerprintPattern.test(value)) {
      tlsFingerprint = value.toUpperCase();
    } else if (value !== undefined) {
      issues.push({ code: 'wrong-type', ...at('tlsFingerprint'), expected: 'fingerprint' });
    }
  }

  let url: string | undefined;
  if (input.url !== undefined) {
    url = fill(input.url, pathOf('url'));
    if (url !== undefined && !siteUrl(url)) issues.push({ code: 'site-url', ...at('url') });
  }

  let manifestFolder: string = defaults.manifestFolder;
  if (input.manifest !== undefined) {
    const folder = fill(input.manifest, pathOf('manifest'));
    const parsed = folder === undefined ? undefined : manifestPath(folder);
    if (parsed !== undefined) manifestFolder = parsed;
    else if (folder !== undefined) issues.push({ code: 'bad-path', ...at('manifest') });
  }

  const uploads: Mapping[] = [];
  for (const [upload, path] of lists.uploads) {
    uploads.push(...(await resolveUploads(upload, path, fill, issues, context)));
  }
  const patterns = lists.exclude.flatMap(([text, path]) => {
    const pattern = fill(text, path);
    return pattern === undefined ? [] : [[pattern, path] as const];
  });
  const exclude = patterns.map(([pattern]) => pattern);
  const writes = resolveWrites(lists.writes, issues, { fill, ...context });
  const pulls = resolvePulls(lists.pulls, issues, { fill, ...context });
  for (const mapping of uploads) {
    const pattern = mapping.kind === 'file' ? excludedBy(mapping, patterns) : undefined;
    if (pattern !== undefined) {
      issues.push({ code: 'excluded-file', ...mapping.place, other: context.place(pattern) });
    }
  }

  const login = input.privateKey !== undefined ? 'private-key' : 'password';
  const facts: TargetFacts = {
    variables: [...variables.values()],
    login,
    hostKey: ftp
      ? 'none'
      : input.hostKey === undefined
        ? 'missing'
        : hostKey === undefined
          ? 'unknown'
          : 'saved',
    ...(url === undefined ? {} : { url }),
    ...(server === undefined ? {} : { host: server.host, server: input.server }),
    pulls,
    ...(server === undefined
      ? {}
      : {
          connection: {
            url: server,
            place: at('server'),
            ...(hostKey === undefined ? {} : { hostKey: { key: hostKey, place: at('hostKey') } }),
            ...(tlsFingerprint === undefined
              ? {}
              : { tlsFingerprint: { sha256: tlsFingerprint, place: at('tlsFingerprint') } }),
            timeoutMs: input.timeout === undefined ? defaults.timeoutMs : durationMs(input.timeout),
          },
        }),
  };
  const credentials = login === 'private-key' ? privateKey : password;
  if (issues.length > 0 || server === undefined || credentials === undefined) {
    return { ok: false, issues: sorted(issues), ...facts };
  }
  const place = (key: (typeof loginKeys)[number]) =>
    input[key] === undefined ? {} : { [key]: at(key) };
  return {
    ok: true,
    ...facts,
    target: {
      name,
      server,
      ...(password === undefined ? {} : { password }),
      ...(privateKey === undefined ? {} : { privateKey }),
      ...(passphrase === undefined ? {} : { passphrase }),
      hostKey,
      ...(tlsFingerprint === undefined ? {} : { tlsFingerprint }),
      url,
      uploads,
      writes,
      pulls,
      exclude,
      parallel,
      timeoutMs: input.timeout === undefined ? defaults.timeoutMs : durationMs(input.timeout),
      manifestFolder,
      allow: new Set<AllowedRisk>(input.allow ?? []),
      checkServer: input.checkServer === true,
      places: {
        server: at('server'),
        ...place('password'),
        ...place('privateKey'),
        ...place('passphrase'),
        hostKey: input.hostKey === undefined ? undefined : at('hostKey'),
        ...(input.tlsFingerprint === undefined ? {} : { tlsFingerprint: at('tlsFingerprint') }),
      },
    },
  };
}

/**
 * `upload: dist` (the folder becomes the target folder itself), or a map `local: remote` (or
 * `local: { to: remote }`). Local folders are relative to the config's folder; remote folders
 * to the target folder (`.` is the target folder). A local file is a single-file mapping: its
 * server side is a file path inside the target folder (R10, spec #24 decision 23).
 */
async function resolveUploads(
  upload: UploadInput,
  path: Path,
  fill: (text: string, path: Path) => string | undefined,
  issues: ConfigIssue[],
  context: Context,
): Promise<Mapping[]> {
  const entries: [local: string, remote: string | undefined, path: Path, mirror: boolean][] =
    typeof upload === 'string'
      ? [[upload, '', path, false]]
      : Object.entries(upload).map(([local, entry]) => {
          const to = typeof entry === 'string' ? entry : entry.to;
          const mirror = typeof entry !== 'string' && entry.mirror === true;
          return [local, fill(to, [...path, local]), [...path, local], mirror];
        });
  const mappings: Mapping[] = [];
  for (const [localText, remoteText, at, mirror] of entries) {
    const local = typeof upload === 'string' ? fill(localText, at) : localText;
    if (local === undefined || remoteText === undefined) continue;
    const place = context.place(at);
    if (local === '' || /\p{Cc}/u.test(local)) {
      issues.push({ code: 'bad-path', ...place });
      continue;
    }
    const abs = resolve(context.folder, local);
    const kind = (await isFile(abs)) ? 'file' : 'folder';
    // A folder goes to a folder (`.` is the target folder); a file to a file path inside it.
    const remote = kind === 'file' ? remoteFile(remoteText) : remoteFolder(remoteText);
    if (remote === undefined) {
      issues.push({
        code: 'remote-path',
        ...place,
        ...(kind === 'file' ? { detail: 'file' } : {}),
      });
      continue;
    }
    // What the `exclude` patterns are written against (ticket 06).
    const localFromConfig = relative(context.folder, abs).split(sep).join('/');
    mappings.push({
      kind,
      local: abs,
      remote,
      localFromConfig,
      place,
      ...(mirror ? { mirror: true } : {}),
    });
  }
  return mappings;
}

function remoteFolder(text: string): RemotePath | '' | undefined {
  if (text === '' || text === '.') return '';
  const parsed = parseRemotePath(text);
  return parsed.ok ? parsed.path : undefined;
}

/**
 * The place of the `exclude` pattern that leaves a single file out, if one does: the pattern
 * after which the list excludes it for good (the last match wins; `!` can re-include it).
 */
function excludedBy(mapping: Mapping, patterns: readonly ListItem[]): Path | undefined {
  const texts = patterns.map(([pattern]) => pattern);
  const excludedAfter = (count: number): boolean =>
    excludeMatcher(texts.slice(0, count))(mapping.localFromConfig);
  if (!excludedAfter(texts.length)) return undefined;
  let count = texts.length;
  while (count > 1 && excludedAfter(count - 1)) count--;
  return patterns[count - 1]?.[1];
}

/** A file path inside the target folder (R10): never the target folder itself. */
function remoteFile(text: string): RemotePath | undefined {
  const parsed = parseRemotePath(text);
  return parsed.ok ? parsed.path : undefined;
}

/** `private/.sealup` → `/~/private/.sealup`; an absolute folder or `/~/…` stays as written. */
function manifestPath(text: string): string | undefined {
  if (text.startsWith('/~/')) return parseRemotePath(text.slice(3)).ok ? text : undefined;
  if (text.startsWith('/')) return parseServerPath(text).ok && text !== '/' ? text : undefined;
  return parseRemotePath(text).ok ? `/~/${text}` : undefined;
}

function siteUrl(text: string): boolean {
  if (/[\p{Cc}\s]/u.test(text) || !URL.canParse(text)) return false;
  const { protocol } = new URL(text);
  return protocol === 'https:' || protocol === 'http:';
}

function durationMs(text: string): number {
  const [, amount, unit] = durationPattern.exec(text) ?? [];
  return Number(amount) * (unit === 'm' ? 60_000 : 1000);
}
