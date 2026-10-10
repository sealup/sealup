// contracts, the config side: what `config` makes of sealup.yml (the server URL, the host key,
// the mappings, the Target) and the issues it finds, at their place in the file. Additions here:
// a Target field, a Mapping kind, a ConfigIssue code or a ConfigExpected value. Lane C #33: the
// files written from a secret (SecretFile, Target.writes).

import type { RemotePath, Secret } from './brands.ts';

// ---------------------------------------------------------------------------------------------
// The target: where a deploy goes (decision 0022). `config` makes one; `deploy` and `transport`
// read it. SFTP only in the skeleton.
// ---------------------------------------------------------------------------------------------

/**
 * `sftp://user@host[:port]/folder`, parsed. Printed back always with the port (R22). `ssh` is
 * SFTP plus a shell: changed files travel as one archive when the server has `tar` (0034). `ftp`
 * is plain FTP: no host key, password and files in clear, a warning on every run (spec #41
 * decisions 10-11, S23). `ftps` is FTP with explicit TLS (`AUTH TLS` on the URL's port, R8): the
 * certificate checked, or pinned by `tlsFingerprint` (decision 8).
 */
export interface ServerUrl {
  readonly protocol: 'sftp' | 'ssh' | 'ftp' | 'ftps';
  readonly user: string;
  readonly host: string;
  /** 22 unless the URL names one; 21 for `ftp` and `ftps`. */
  readonly port: number;
  /**
   * Absolute (`/home/site`), or relative to the login folder when it starts with `/~/` (spec
   * #1, "Server folder and login folder"); `paths.resolveServerFolder` turns it into a ServerPath
   * once the login folder is known.
   */
  readonly folder: string;
}

/** The pinned server key: one OpenSSH public key line (`<type> <base64>`), checked by config. */
export interface HostKey {
  /** The key type, e.g. `ssh-ed25519`. */
  readonly type: string;
  /** The key blob, base64, as in the OpenSSH line. */
  readonly key: string;
  /** OpenSSH form, `SHA256:<base64 without padding>`: what the target block prints. */
  readonly fingerprint: string;
}

/**
 * One `upload` entry: a local folder sent to a folder under the target folder, or a single local
 * file sent to a file path under it, maybe under another name (scope v1, spec #24 decision 23).
 */
export interface Mapping {
  /**
   * `file` when the local side is a file when the config is read; anything else (a folder, or
   * nothing yet: the missing-source net stops it) is a `folder`.
   */
  readonly kind: 'folder' | 'file';
  /** Absolute local folder, or file. */
  readonly local: string;
  /**
   * Where it goes, relative to the target folder: a folder (`''` is the target folder itself),
   * or for a file, its own path (never `''`).
   */
  readonly remote: RemotePath | '';
  /**
   * The local side relative to the folder of sealup.yml, `/`-separated (`''` for that folder,
   * `../…` outside it): what the `exclude` patterns are written against (decision 0022).
   */
  readonly localFromConfig: string;
  /** The entry's place in the config: what a message about two entries cites (R6). */
  readonly place: ConfigPlace;
  /**
   * `mirror: true` in the long form (decision 0030): every deploy also deletes what its server
   * folder holds that is not in the build. Absent otherwise (`--mirror` turns it on for a run).
   */
  readonly mirror?: true;
}

/**
 * One `write` entry: a server file written from a secret (decision 0004, R17, spec #24 decision
 * 24). Never tool-owned: not in the manifest, never deleted, forgotten once its entry is gone
 * (owner ruling 8).
 */
export interface SecretFile {
  /** Where it goes, relative to the target folder: a file path, never `''`. */
  readonly path: RemotePath;
  /** The file's content, from one variable (R3); multi-line allowed. */
  readonly secret: Secret;
  /** Permission bits, set before the first byte (default `0o600`). */
  readonly mode: number;
  /** The public-folder net is off for this file (`allowPublic: true`). */
  readonly allowPublic: boolean;
  /** The entry's place in the config: what a message about it cites (R6). */
  readonly place: ConfigPlace;
}

/**
 * One `pull` entry (decision 0002, spec #24 decision 25, R19): a server folder or file under the
 * target folder, copied to this machine by `sealup pull`. Which of the two it is, the server says.
 */
export interface PullEntry {
  /** Relative to the target folder (`''` is the target folder itself). */
  readonly remote: RemotePath | '';
  /** Where it goes: a folder (or a file) inside the folder of sealup.yml, absolute. */
  readonly local: string;
  /** The local side from the folder of sealup.yml, `/`-separated (never `''`, never `../…`). */
  readonly localFromConfig: string;
  /** The entry's place in the config. */
  readonly place: ConfigPlace;
}

/**
 * A risk a target may take on purpose (`allow:`): `empty-source` (R20), `symlinks` (spec #41
 * decision 28: links in a source folder are skipped, server links in the target folder left alone),
 * `root-folder` (R20, decision 0029: a mirrored deploy into `/`, `~` or the login folder).
 */
export type AllowedRisk = 'empty-source' | 'symlinks' | 'root-folder';

/**
 * Where a target's connection keys are in the config, for messages that cite them (S17-S19).
 * The login's keys are there when the config has them (decision 0033).
 */
interface TargetPlaces {
  readonly server: ConfigPlace;
  readonly password?: ConfigPlace;
  readonly privateKey?: ConfigPlace;
  readonly passphrase?: ConfigPlace;
  readonly hostKey: ConfigPlace | undefined;
  readonly tlsFingerprint?: ConfigPlace;
}

/**
 * A resolved target: everything a deploy needs to know about where it goes. It logs in with
 * exactly one of `password` and `privateKey` (decision 0033); `passphrase` only with the key.
 */
export interface Target {
  /** The name under `targets:`; the shorthand target is named after the server's host (ruling 4). */
  readonly name: string;
  readonly server: ServerUrl;
  /** The login password (R4: one line). */
  readonly password?: Secret;
  /**
   * The login key, as its file holds it (OpenSSH or PEM): several lines, held as a Secret whose
   * every line is masked (R2). Parsed by transport alone, before it connects.
   */
  readonly privateKey?: Secret;
  /** What opens an encrypted `privateKey` (R4: one line). */
  readonly passphrase?: Secret;
  /**
   * Absent when the config has no `hostKey`: a deploy over SSH stops before connecting (R7, S16).
   * Never read for `ftp` and `ftps`, which have no host key.
   */
  readonly hostKey: HostKey | undefined;
  /**
   * `ftps` only (R8, spec #41 decision 8): the pinned certificate's SHA-256, colon-separated
   * uppercase hex. Set, it replaces both the CA and the host name checks: the server must show
   * that certificate. Absent, the certificate must be trusted and name the host.
   */
  readonly tlsFingerprint?: string;
  /** The site address, printed under the result line. */
  readonly url: string | undefined;
  readonly uploads: readonly Mapping[];
  /** The files written from a secret (shared list + the target's), in config order. */
  readonly writes: readonly SecretFile[];
  /** What `sealup pull` copies here (shared list + the target's), in config order. */
  readonly pulls: readonly PullEntry[];
  /** `.gitignore` patterns, local side: never sent, never deleted (shared list + the target's). */
  readonly exclude: readonly string[];
  /**
   * How much runs at once, by protocol (spec #41 decision 4). SFTP and SSH: requests in flight at
   * most, across the connection's channels (default 64, 0026). FTP: connections, each carrying
   * one transfer at a time (default 4, at most 16).
   */
  readonly parallel: number;
  /** Per-operation timeout in ms (default 30 s, R21). */
  readonly timeoutMs: number;
  /**
   * The manifest folder (R14), in the form of ServerUrl.folder: absolute, or relative to the
   * login folder when it starts with `/~/` (default `/~/.sealup`; `manifest: private/.sealup`
   * gives `/~/private/.sealup`). `paths.resolveServerFolder` makes it a ServerPath.
   */
  readonly manifestFolder: string;
  /** The safety nets this target turns off on purpose (`allow:`). */
  readonly allow: ReadonlySet<AllowedRisk>;
  /**
   * `checkServer: true`: every deploy to it lists the folders that hold tool-owned files and puts
   * back those changed on the server (spec #41 decision 26). Off by default; `--check-server`
   * turns it on for one run.
   */
  readonly checkServer: boolean;
  /** Where its connection keys are in the config. */
  readonly places: TargetPlaces;
}

/**
 * A variable a target's values read that is set, and where its value came from (`check`, S06):
 * the name and the source, never the value (R6). `env-file`: sealup.env, or the `--env-file`.
 */
export interface VariableSource {
  readonly name: string;
  readonly from: 'environment' | 'env-file';
}

// ---------------------------------------------------------------------------------------------
// Config problems, at their place in the file.
// ---------------------------------------------------------------------------------------------

/** Where something is in a config file: what messages cite (R6: places, never values). */
export interface ConfigPlace {
  /** The config file, absolute. */
  readonly file: string;
  /** 1-based; absent when the problem has no line (file not found). */
  readonly line?: number;
  /** Where in the file, e.g. `targets.production.password`; empty for the whole file. */
  readonly keyPath: string;
}

/** One config problem, at its place (R6: a place and a variable name, never a value). */
export interface ConfigIssue extends ConfigPlace {
  readonly code:
    | 'file-not-found'
    /** Both sealup.yml and sealup.yaml in one folder; `file` is the first. */
    | 'file-ambiguous'
    /** The `--env-file` does not exist; `file` is that file. */
    | 'env-file-not-found'
    | 'yaml'
    | 'unknown-key'
    | 'missing-key'
    /** The value has the wrong type or form; `expected` says what the key takes. */
    | 'wrong-type'
    /** A shorthand key (`server`, `password`, …) at the top level of a file with `targets:`. */
    | 'shorthand-with-targets'
    | 'no-targets'
    /** A `$` form sealup does not read (`$NAME`, a lone `$`, `${A:-b}`). */
    | 'variable-syntax'
    | 'server-url'
    | 'host-key'
    | 'site-url'
    /** A folder that is not a valid path for its key (R10); the key says which kind. */
    | 'bad-path'
    /** The server side of an `upload` pair is not a folder inside the target folder (R10). */
    | 'remote-path'
    | 'secret-in-config'
    | 'variable-not-set'
    | 'secret-refused'
    /**
     * A single file of `upload` that an `exclude` pattern matches (story 44): `other` is the
     * pattern's place. Exclude never silently loses to upload, nor the reverse.
     */
    | 'excluded-file'
    /**
     * Two entries send one server path (story 43), found once the source folders are read:
     * `path` is that path, `other` the earlier entry; the issue's own place is the later one.
     */
    | 'same-server-path'
    /**
     * A target's login (decision 0033): `detail` is `none` (neither password nor privateKey),
     * `both` (at privateKey, `other` the password), `passphrase-alone` (no privateKey), or
     * `ftp-key` (a privateKey on an `ftp://` target, which logs in with a password only).
     */
    | 'login'
    /** A key or value this version cannot honour; `detail` names the value when it is one. */
    | 'not-available-yet';
  /** file-not-found after a search: the highest folder searched (the repo root). */
  readonly searchedUpTo?: string;
  /** The variable involved (variable-not-set, secret-refused). */
  readonly variable?: string;
  /**
   * secret-refused: the rule that refused the value, never the value (R6). `too-short`: under
   * `shortestSecret` characters (R2); `unsafe-character`: CR, LF or NUL, or space at either end
   * (R4).
   */
  readonly reason?: 'too-short' | 'unsafe-character';
  /** variable-not-set: the `${VAR:?message}` message, the config's own words. */
  readonly message?: string;
  /** variable-not-set: the env file sealup read besides the environment. */
  readonly envFile?: string;
  /** wrong-type: what the key takes. */
  readonly expected?: ConfigExpected;
  /** excluded-file, same-server-path: the other entry, so a message names both lines. */
  readonly other?: ConfigPlace;
  /** same-server-path: the path both entries send, relative to the target folder. */
  readonly path?: string;
  /**
   * `yaml`: the parser's error code (its words, never a value of ours). not-available-yet: the
   * value this version cannot honour (a protocol such as `ftp`, an `allow` value). remote-path:
   * `file` when the local side is a single file (its server side must be a file path), or for a
   * `write` entry. secret-in-config: `write` when the value is a file's content, `privateKey` or
   * `passphrase` for those keys; absent for a password. remote-path and bad-path: `pull` for a
   * `pull` entry's server or local side. login: `none`, `both`, `passphrase-alone` or `ftp-key`.
   */
  readonly detail?: string;
}

/** `parallel` over `ftp://` and `ftps://` is connections: never more than this (spec #41 decision 4). */
export const maxFtpConnections = 16;

/**
 * Whether a server speaks FTP (`ftp://` or `ftps://`): `parallel` counts connections, the login
 * is a password, and there is no host key (FTPS checks a certificate instead).
 */
export function isFtp(protocol: ServerUrl['protocol']): boolean {
  return protocol === 'ftp' || protocol === 'ftps';
}

/** What a config key takes, for a wrong-type issue. */
export type ConfigExpected =
  | 'mapping'
  | 'text'
  | 'count'
  /** `parallel` of an `ftp://` or `ftps://` target: connections, a whole number from 1 to 16. */
  | 'connections'
  /** `tlsFingerprint`: a SHA-256, 32 colon-separated pairs of hex digits. */
  | 'fingerprint'
  | 'duration'
  | 'upload'
  | 'upload-entry'
  | 'targets'
  | 'target'
  | 'target-name'
  | 'allow'
  | 'patterns'
  /** `write`: server paths with their secrets. */
  | 'write'
  /** One `write` entry: `${VAR}`, or the long form. */
  | 'write-entry'
  /** A file mode, as an octal string. */
  | 'mode'
  /** true or false. */
  | 'yes-no'
  /** `pull`: server paths with the local folders they go to. */
  | 'pull';
