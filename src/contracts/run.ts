// contracts, the run: what a run tells the outside (its problems, its Outcome, its events, the
// Reporter port) and the exit codes. Additions here: a Problem, an Outcome field, an event, a
// HostKeyCheck state. A new exit code is a breaking change (decision 0026).

import type { RemotePath, ServerPath } from './brands.ts';
import type {
  ConfigIssue,
  ConfigPlace,
  PullEntry,
  ServerUrl,
  Target,
  VariableSource,
} from './config.ts';
import type { ManifestProblem, Plan } from './plan.ts';
import type {
  CertificateScan,
  HostKeyId,
  ScannedHostKey,
  ServerCertificate,
  TransportError,
  TransportErrorCode,
} from './session.ts';

// ---------------------------------------------------------------------------------------------
// What a run tells the outside: events while it runs, an Outcome at the end. The reporters
// (terminal, JSON) render from these only (decision 0024); they hold facts, never words.
// ---------------------------------------------------------------------------------------------

/** Why a run stopped: facts for report to word, with the docs slug it links. */
export type Problem =
  /** A command line sealup cannot run; `name` is the command or flag, as typed. */
  | {
      readonly code: 'usage';
      readonly reason:
        | 'no-command'
        | 'unknown-command'
        /** `deploy` got more than one target name (`count`). */
        | 'extra-arguments'
        | 'unknown-flag'
        | 'missing-value'
        /** `-q` and `-v` together: a half-quiet mix is never printed. */
        | 'quiet-and-verbose'
        /** `--json` on a command that prints text only: `name` is `help`, or absent for `sealup`. */
        | 'json-not-taken'
        /** `sealup help <name>` with no such topic; `suggestion` is the closest one. */
        | 'unknown-topic'
        /** The action: `working-directory` (`name`, as given) is outside GITHUB_WORKSPACE. */
        | 'outside-workspace'
        /** The action ran without GITHUB_WORKSPACE: not in GitHub Actions. */
        | 'no-workspace'
        /** The action: the input `name` takes true or false (GitHub's booleans). */
        | 'not-true-or-false'
        /**
         * `init --server` (`name`) with an address sealup cannot use as a server URL (R3: never
         * printed, it may hold a password).
         */
        | 'bad-server-address'
        /** `init --from` (or the conversion offered): `name`, the file, is not sam-sync's JSON. */
        | 'not-sam-sync'
        /** A sam-sync conversion retained no upload or pull operation. */
        | 'sam-sync-no-actions'
        /** `init --from` and `--server` together: one way to set up at a time. */
        | 'from-and-server'
        /** A flag (`name`, as typed) that command `command` cannot honour: never ignored. */
        | 'flag-not-taken';
      readonly name?: string;
      readonly count?: number;
      /** unknown-topic: the closest topic, when one is close (did-you-mean). */
      readonly suggestion?: string;
      /** flag-not-taken: the command that cannot honour the flag. */
      readonly command?: string;
    }
  | { readonly code: 'not-available-yet'; readonly what: string }
  /**
   * `sealup init` without a terminal to ask in and without `--server` (S02's CI form, exit 2).
   * `deploymentJson`: a sam-sync `.deployment.json` is there, so `--from` is named too (0023 §9).
   */
  | { readonly code: 'no-terminal'; readonly deploymentJson: boolean }
  /** `sealup init` where sealup.yml (`file`, absolute) already is: nothing written (exit 2). */
  | { readonly code: 'config-exists'; readonly file: string }
  | {
      readonly code: 'config';
      readonly issues: readonly ConfigIssue[];
      /** The chosen target the issues belong to; absent for problems of the file itself. */
      readonly target?: string;
    }
  | {
      readonly code: 'unknown-target';
      readonly name: string;
      readonly names: readonly string[];
      /** The closest target name, when one is close (did-you-mean). */
      readonly suggestion?: string;
      readonly configFile: string;
      /** The command the name was given to, for the did-you-mean; default `deploy`. */
      readonly command?: string;
    }
  | {
      readonly code: 'target-not-named';
      readonly names: readonly string[];
      readonly configFile: string;
      /** The command that needs a name, for the commands to type; default `deploy`. */
      readonly command?: string;
    }
  | { readonly code: 'host-key-missing'; readonly configFile: string }
  /**
   * The target's private key cannot be read (decision 0033, exit 2): not a key sealup reads, an
   * encrypted one and no passphrase, or a passphrase that does not open it. Found by transport
   * before it dials: nothing reached the server.
   */
  | {
      readonly code: 'private-key-unreadable';
      readonly reason: 'key-unreadable' | 'passphrase-missing' | 'passphrase-wrong';
      readonly target: string;
    }
  /**
   * `sealup keyscan` (exit 4, spec #24 decision 18): the server shows another key than the one
   * saved, and it was not replaced: the answer was no (`asked`), or there was no terminal to ask.
   */
  | {
      readonly code: 'host-key-not-replaced';
      readonly target: string;
      readonly server: ServerUrl;
      readonly configFile: string;
      /** The saved key, and its place in the config. */
      readonly expected: HostKeyId;
      readonly place: ConfigPlace;
      /** The key the server showed. */
      readonly received: ScannedHostKey;
      readonly asked: boolean;
      /**
       * The variable `hostKey` reads (`${NAME}`), which keyscan never writes over: the person
       * updates it in sealup.env and in CI (plan 06 spec #88 decision 8). Never asked then.
       */
      readonly variable?: string;
    }
  /**
   * `sealup keyscan` on `ftps://` (exit 4, spec #41 decision 12): the server shows another
   * certificate than the one `tlsFingerprint` pins, and the pin was not replaced: the answer was
   * no (`asked`), or there was no terminal to ask.
   */
  | {
      readonly code: 'certificate-not-replaced';
      readonly target: string;
      readonly server: ServerUrl;
      readonly configFile: string;
      /** The pinned SHA-256, and its place in the config. */
      readonly expected: string;
      readonly place: ConfigPlace;
      /** The certificate the server showed. */
      readonly received: ServerCertificate;
      readonly asked: boolean;
      /** The variable `tlsFingerprint` reads (`${NAME}`), never written over; as above. */
      readonly variable?: string;
    }
  /**
   * Safety net R20 (exit 6, S21): a source folder is missing or would send no file, so a
   * deploy could delete the site. Found before connecting: no target block (ruling 3).
   */
  | {
      readonly code: 'empty-source';
      /** The source folder as the config names it: from the config folder, `/`-separated. */
      readonly folder: string;
      /**
       * The local path does not exist (rather than holding no file to send): a file or a folder,
       * no one can tell, and `allow: [empty-source]` does not let it through.
       */
      readonly missing: boolean;
      /** Where its files go, in the config's form (target folder + upload's server folder). */
      readonly serverFolder: string;
      readonly target: string;
      /** The upload entry's place in the config (decision 31: the annotation's file and line). */
      readonly place: ConfigPlace;
    }
  /**
   * R14 (exit 2, ruling 9, decision 0038): the manifest folder is a mapping's server folder or
   * inside one (a folder sealup sends files to, where visitors could download it). Found before
   * connecting when both folders are in one form (no target block), else right after login,
   * before any change.
   */
  | {
      readonly code: 'manifest-inside-target';
      /** As the config gives it before connecting; resolved (absolute) once connected. */
      readonly manifestFolder: string;
      /** In the same form as manifestFolder. */
      readonly targetFolder: string;
      /**
       * The mapping's server folder that holds it (a single file's own path), in the same form:
       * the target folder itself for a mapping into it.
       */
      readonly serverFolder: string;
      /** That mapping's entry in the config. */
      readonly place: ConfigPlace;
      readonly connected: boolean;
      /**
       * Whether the login folder is that mapping's server folder or inside it: the default
       * manifest folder (`.sealup` in the login folder) is refused there too. Absent: no.
       */
      readonly loginFolderInside?: boolean;
      readonly target: string;
    }
  /**
   * Safety net (exit 6): a symbolic link sealup will not go through. `source`: in a source folder
   * (spec #1 scan), where following it could send files from outside the project; found before
   * connecting, so no target block (ruling 3). `server`: a folder on the server the run writes or
   * deletes in, or one of the folders above it inside the target folder (R16, spec #41 decision
   * 27), where writing through it could land outside the target folder; found after login,
   * before any change.
   */
  | {
      readonly code: 'symlink';
      readonly on: 'source' | 'server';
      /** The link: from the config folder, `/`-separated (`source`); absolute (`server`). */
      readonly path: string;
      readonly target: string;
    }
  /**
   * Safety net R17 (exit 6): a file written from a secret would land in a folder that looks
   * public (`www`, `public_html`, …), where visitors could download it; `allowPublic: true` on
   * its entry turns the net off. Found before connecting: no target block (ruling 3).
   */
  | {
      readonly code: 'secret-file-public';
      /** The file's full server path, in the config's form (target folder + its path). */
      readonly path: string;
      /** The folder of that path that looks public, as written; with `mode-refused`, the target's. */
      readonly folder: string;
      /** The `write` entry. */
      readonly place: ConfigPlace;
      readonly target: string;
      /**
       * `mode-refused`: the server cannot set a file's mode (FTP without SITE CHMOD, spec #41
       * decision 7), so the file would be readable by others; found right after login, before
       * any change. Absent: the folder looks public (before connecting).
       */
      readonly reason?: 'mode-refused';
    }
  /**
   * Safety net R20 (exit 6, decision 0029): the mirror is on (decision 0030) and the target
   * folder is the server's root or the login folder, where it would delete whatever else the
   * account holds; `allow: [root-folder]` lets it through. Found before connecting for `/`, `/~`
   * and `/~/` (no target block), else right after login, before any change.
   */
  | {
      readonly code: 'risky-folder';
      /** The target folder: as the config gives it before connecting; absolute once connected. */
      readonly folder: string;
      readonly connected: boolean;
      /** The first `mirror: true` mapping's place; absent when `--mirror` turned the mirror on. */
      readonly mirror?: ConfigPlace;
      /**
       * The server folders the mirror would list, in the form of `folder`, outermost only and
       * sorted; absent (or holding `folder` itself) when it mirrors the target folder itself.
       */
      readonly mirrored?: readonly string[];
      readonly target: string;
    }
  | { readonly code: 'manifest-unusable'; readonly reason: ManifestProblem }
  /**
   * Another run holds the target folder's lock (exit 6, decision 0031): found right after login,
   * before any change. `holder`: what its note says; absent when the note cannot be read (missing,
   * cut short, not sealup's), and then `lock` is the folder to remove by hand.
   */
  | {
      readonly code: 'lock-held';
      readonly target: string;
      /** The lock folder, absolute. */
      readonly lock: ServerPath;
      readonly holder?: LockHolder;
    }
  /**
   * `sealup pull` without a terminal (0002, 0023 §7, S25): a CI runner is thrown away, and the
   * files with it. Refused right after reading sealup.yml, exit 2. `target`: the name given, or
   * the only target's.
   */
  | { readonly code: 'pull-in-ci'; readonly target?: string }
  /** `sealup pull` to a target without `pull:` entries (exit 2): the line to add. */
  | { readonly code: 'no-pull-entries'; readonly target: string; readonly configFile: string }
  /**
   * Safety net R10/R19 (exit 6): a name the server listed that pull may not write here, found
   * before any local write. `path`: where the server holds it, absolute (it may hold any
   * character: report prints it safely).
   */
  | {
      readonly code: 'pull-unsafe-name';
      readonly path: string;
      readonly reason: UnsafeName;
      readonly target: string;
    }
  /**
   * Safety net R19 (exit 6): a local path the pull goes through or writes is held by something
   * it may not write through or over (a link or junction, or the other kind), found with lstat
   * before any local write. `path`: from the folder of sealup.yml, `/`-separated.
   */
  | {
      readonly code: 'pull-local-path';
      readonly path: string;
      readonly found: 'link' | 'file' | 'folder' | 'other';
      readonly needs: 'file' | 'folder';
      readonly target: string;
    }
  /**
   * Safety net R21 (exit 6): the server's listing passed a limit (`max` entries in one folder,
   * files in all, or levels of folders), so sealup stopped before reading more; nothing written.
   */
  | {
      readonly code: 'pull-too-large';
      /** The folder where the limit was passed, absolute. */
      readonly path: ServerPath;
      readonly limit: 'entries' | 'files' | 'depth';
      readonly max: number;
      readonly target: string;
    }
  /**
   * Safety net R21 (exit 6, spec #41 decisions 26 and 31): a deploy's listing of the server passed
   * a cap (`max` entries in all, or levels of folders below the target folder), so sealup stopped
   * listing, before any change. `for`: what the listing was for (the server check, or the full
   * mirror, decision 0030).
   */
  | {
      readonly code: 'listing-too-large';
      /** The folder where the cap was passed, absolute. */
      readonly path: ServerPath;
      readonly limit: 'entries' | 'depth';
      readonly max: number;
      readonly for: 'check-server' | 'mirror';
      readonly target: string;
    }
  /**
   * A pull that stopped after some files arrived here: they stay, and the same command finishes
   * the job. `error`: what stopped it (a TransportError, or an error sealup did not expect);
   * absent for Ctrl-C (exit 130). Exit 1 otherwise. The server never changes in a pull.
   */
  | {
      readonly code: 'pull-part-way';
      readonly error?: Error;
      readonly downloaded: number;
      readonly downloads: number;
      readonly target: string;
    }
  | ({ readonly code: 'transport'; readonly error: TransportError } & StopState)
  /**
   * A local file whose name no server path can hold (R10): a control character, a `\` (on
   * POSIX, where it is part of a name), a drive letter. Found while scanning, before connecting,
   * so nothing changed: exit 6, like the other checks of the source folders.
   */
  | {
      readonly code: 'bad-local-name';
      /** The file, from the config folder, `/`-separated (as `exclude` patterns see it). */
      readonly path: string;
      readonly reason: 'control-character' | 'backslash' | 'drive-letter' | 'other';
      /** Found before the start event, so the problem names the target (ruling 3). */
      readonly target: string;
    }
  /**
   * The build needs a path the server holds as the other kind (S1): a file where it needs a
   * folder, or a folder where it needs a file; and sealup may not remove it: a file it keeps on
   * purpose (excluded, found by plan before any change), or something it did not upload (found
   * by the server). Exit 6 when nothing changed yet, 1 once something did.
   */
  | ({
      readonly code: 'in-the-way';
      /** The path the build needs, absolute. */
      readonly path: ServerPath;
      readonly found: 'file' | 'folder';
      readonly held: 'excluded' | 'not-uploaded';
    } & StopState)
  /**
   * A question on the terminal left without an answer (Esc or Ctrl-C at the target picker or a
   * prompt): exit 130, nothing done (spec #24 decisions 15-16). `picker`: the target picker.
   */
  | { readonly code: 'cancelled'; readonly picker: boolean }
  /** Ctrl-C (the AbortSignal): exit 130 (decision 0023), whatever was done before. */
  | ({ readonly code: 'interrupted' } & StopState)
  /**
   * A bug in sealup, or a local failure it has no words for (a file that vanished while it was
   * sent). Its message and stack are shown only with `--debug`. `changed` is undefined when
   * sealup cannot tell whether the server changed.
   */
  | ({ readonly code: 'unexpected'; readonly error: Error } & StopState<boolean | undefined>);

/**
 * Why a name a server listed cannot be written here by `sealup pull` (R10 with the Windows
 * rules; R21: 255 bytes).
 */
export type UnsafeName =
  /** Empty, `.` or `..`. */
  | 'dot-name'
  /** A `/`: a path, not a name. */
  | 'slash'
  | 'backslash'
  | 'control-character'
  | 'not-nfc'
  /** `< > : " | ? *`, which Windows does not allow in a name. */
  | 'windows-character'
  /** `CON`, `NUL`, `COM1`… with or without an extension. */
  | 'windows-reserved'
  /** Windows drops a dot or a space at the end of a name. */
  | 'trailing-dot-space'
  /** Over 255 bytes in UTF-8. */
  | 'too-long'
  /** The form of sealup's own temp files (R10: sealup's names are reserved). */
  | 'sealup-temp';

/**
 * The run that holds a target folder's lock, as its note says (decision 0031). Read from the
 * server: untrusted (R12), so report prints its strings safely.
 */
export interface LockHolder {
  /** The run's random id. */
  readonly run: string;
  /** When it started, ms since 1970 (its machine's clock). */
  readonly started: number;
  /** When its note was last written, ms since 1970 (its machine's clock). */
  readonly refreshed: number;
  /** The name of the machine it runs on. */
  readonly machine: string;
  /** The CI run's page, when it runs in CI (GitHub Actions). */
  readonly ciRun?: string;
}

/** How far a run got before it stopped on a problem that can come part-way. */
interface StopState<Changed = boolean> {
  /** Whether the server changed before it stopped: decides exit 1 vs the problem's own code. */
  readonly changed: Changed;
  /** What the run got done before it stopped; absent when it stopped before executing. */
  readonly run?: PartialRun;
}

/**
 * What a run that stopped after it began to execute got done: the facts its state line tells
 * (what changed on the server, and what the same command run again will do).
 */
export interface PartialRun {
  /** Uploads in the plan. */
  readonly uploads: number;
  /** Uploads that arrived (in place under their final name). */
  readonly arrived: number;
  /** The uploads that did not arrive (refused, or never started), in path order. */
  readonly missing: readonly { readonly path: RemotePath; readonly size: number }[];
  /** How many of `missing` the server refused or failed; the rest were never started. */
  readonly refused: number;
  /** Files written from a secret in the plan, and how many are in place (they come after). */
  readonly writes: number;
  readonly written: number;
  /** Deletes in the plan, and how many were done (none until every upload arrived). */
  readonly deletes: number;
  readonly deleted: number;
  /** The manifest was written: it records what arrived, so the rerun sends only the rest. */
  readonly recorded: boolean;
}

/** Time spent in each phase, ms. */
export interface Timings {
  readonly connect: number;
  readonly scan: number;
  readonly compare: number;
  readonly transfer: number;
  /**
   * Reconnecting after a lost connection (spec #41 decision 20): the waits, the new logins and
   * the re-plans. Present when the run tried to reconnect.
   */
  readonly reconnect?: number;
}

/**
 * How a run ended. On a dry run (the `start` event says so) the counts and bytes are what the
 * run would do, and `status` is `unchanged` when the plan is empty, `ok` otherwise.
 */
export interface Outcome {
  /**
   * `unchanged`: the plan had nothing to do, so nothing was sent or written (S09). `partial`: it
   * stopped after changing the server (exit 1). `cancelled`: Ctrl-C (exit 130). `failed`: it
   * stopped on a problem before changing anything.
   */
  readonly status: 'ok' | 'unchanged' | 'partial' | 'failed' | 'cancelled';
  readonly exitCode: ExitCode;
  readonly uploaded: number;
  /** Files written from a secret (R17): put in place, or on a dry run, to put. */
  readonly written: number;
  /** Files sealup uploaded before and removed now (R13). */
  readonly deleted: number;
  /** Unchanged files; for a pull, the files already here (same size and date). */
  readonly unchanged: number;
  /** A pull's files that arrived here (or on a dry run, to download); absent on a deploy. */
  readonly downloaded?: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly timings: Timings;
  /** Why it stopped; present exactly when status is `partial`, `failed` or `cancelled`. */
  readonly problem?: Problem;
  /** After a run that stopped part-way: each operation that failed, with its error code. */
  readonly failed?: readonly FailedOp[];
  /**
   * How many times the run reconnected after a lost connection and went on (spec #41 decision
   * 20). Present when it tried to reconnect.
   */
  readonly reconnects?: number;
}

/** A file whose upload or delete failed. */
export interface FailedOp {
  readonly path: RemotePath;
  readonly code: TransportErrorCode;
}

/** The host key line of the target block. */
export type HostKeyCheck =
  | { readonly state: 'verified'; readonly fingerprint: string }
  /** No `hostKey` in the config: sealup does not connect (R7, S16). */
  | { readonly state: 'missing' }
  /** The server sent another key: sealup stopped before logging in (S17). */
  | { readonly state: 'changed'; readonly received: HostKeyId }
  /** The connection failed before the server showed its key (S19). */
  | { readonly state: 'not-checked' }
  /** The protocol has no host key to check: plain FTP (S23, spec #41 decision 10). */
  | { readonly state: 'none' }
  /**
   * FTPS (spec #41 decision 10): the server's TLS certificate stands for its host key. `verified`
   * by the CAs and the host name, `pinned` (its SHA-256 is the target's `tlsFingerprint`), or
   * `refused` (the connect stopped on it, before the login, R8).
   */
  | {
      readonly state: 'certificate';
      readonly certificate: ServerCertificate;
      readonly check: 'verified' | 'pinned' | 'refused';
    };

/**
 * A risk a run takes that the person must see every time, but that does not stop it: facts for
 * report to word (spec #41 decision 11). `plain-ftp`: the target is `ftp://`, so the password and
 * the files travel unencrypted (S23); the words name the target's server line.
 */
export interface RunWarning {
  readonly code: 'plain-ftp';
}

/** How far the uploads are: sent after each file that arrived. */
export interface Progress {
  readonly files: number;
  readonly totalFiles: number;
  readonly bytes: number;
  readonly totalBytes: number;
  /** Since the run started, on the run's clock. */
  readonly elapsedMs: number;
  /** Since the transfer started, on the run's clock: what the log's 25/50/75 % lines show. */
  readonly transferMs: number;
}

/**
 * What happens during a run, in order: `start` (the target is chosen and the safety nets that
 * need no server passed), `host-key` (once known: before connecting when missing, after the
 * check otherwise), `transfer` (`ssh://` only), `lock` when another run's lock was found and
 * the run goes on, `plan`, `progress` after each upload that arrived (with the archive, after
 * each file it passed on), with `reconnecting` and `reconnected` between them when the
 * connection was lost (spec #41 decision 20), then always `done`. A run
 * that stops before that (a config error, an empty source, a symlink) sends only `done` (ruling
 * 3: no target block).
 */
export type DeployEvent =
  | {
      readonly type: 'start';
      readonly target: Target;
      readonly configFile: string;
      /** A dry run: it connects, reads the manifest and plans, then stops, changing nothing. */
      readonly dryRun: boolean;
      /** What this run risks without stopping, printed after the target block (S23). */
      readonly warnings: readonly RunWarning[];
    }
  | ({ readonly type: 'host-key' } & HostKeyCheck)
  /**
   * How changed files travel to an `ssh://` target (0034), right after its host key verified:
   * `archive`, as one archive into the server's `tar`; `file-by-file`, over SFTP, the server
   * having no `tar` or no shell, or (`reason: 'login-folder'`, 0039) a login folder whose name
   * may not go in a command (R15), so the server was never asked. Never sent for another
   * protocol.
   */
  | {
      readonly type: 'transfer';
      readonly via: 'archive' | 'file-by-file';
      readonly reason?: 'login-folder';
    }
  /**
   * FTP (story 16): the pool opened fewer connections than `parallel` asks, the server turning
   * the others away; after each login that got fewer (a reconnect makes a new pool).
   */
  | { readonly type: 'pool'; readonly connections: number }
  /**
   * The lock was found held and the run goes on (decision 0031): a dry run, which never takes it
   * (`stale`: a deploy would take it over), or a deploy that took over a note not rewritten for
   * 10 minutes (`stale` is then true). After `host-key`, before `plan`. `holder` is absent when
   * the note cannot be read.
   */
  | {
      readonly type: 'lock';
      readonly stale: boolean;
      readonly holder?: LockHolder;
      /**
       * The holder's silence, ms: on a takeover, the server's now minus the last date in the lock
       * (decision 0040); on a dry run, now minus its note's `refreshed`, on this machine's clock.
       */
      readonly silentMs?: number;
    }
  | { readonly type: 'plan'; readonly plan: Plan }
  | ({ readonly type: 'progress' } & Progress)
  /**
   * The transfer lost its connection after the first login (spec #41 decision 20, S11): try
   * `attempt` of `attempts` is about to wait, log in again and check the host key again. `code`:
   * what stopped the transfer (the first try), or what stopped the try before.
   */
  | {
      readonly type: 'reconnecting';
      readonly attempt: number;
      readonly attempts: number;
      readonly code: TransportErrorCode;
      /** Uploads arrived so far, of the plan's. */
      readonly files: number;
      readonly totalFiles: number;
    }
  /** Logged in again on try `attempt`: the transfer goes on with `filesLeft` uploads. */
  | { readonly type: 'reconnected'; readonly attempt: number; readonly filesLeft: number }
  | { readonly type: 'done'; readonly outcome: Outcome };

/** Takes the events of a run (the second port: terminal and JSON reporters). */
export interface Reporter {
  on(event: DeployEvent): void;
}

// ---------------------------------------------------------------------------------------------
// `sealup check` (spec #24 decision 14): not a run with progress, but one result of facts that
// report words (S06). Offline: nothing here comes from a server.
// ---------------------------------------------------------------------------------------------

/** One `upload` entry as check found it on the local disk. */
export interface UploadCheck {
  /** The local side, from the config folder, `/`-separated (`''`: that folder itself). */
  readonly local: string;
  readonly kind: 'folder' | 'file';
  /** The files it sends: excluded files left out. */
  readonly files: number;
}

/** One target as check found it: what a deploy to it would do before connecting. */
export interface TargetCheck {
  readonly name: string;
  /** The target, when its config resolved: what the words of its problem name. */
  readonly target?: Target;
  /** What a deploy to it would stop on before connecting; absent when it is ready. */
  readonly problem?: Problem;
  /** That deploy's exit code: 0 when ready, else the problem's (2, 4 or 6). */
  readonly exitCode: ExitCode;
  /** The variables its values read that are set, and where from (never a value, R6). */
  readonly variables: readonly VariableSource[];
  /**
   * `unknown`: its hostKey line cannot be read (its problem says why). `none`: its protocol has
   * no host key (`ftp://`, and `ftps://`, whose certificate is checked at connect; spec #41
   * decision 10).
   */
  readonly hostKey: 'saved' | 'missing' | 'unknown' | 'none';
  /** How it logs in, as its config says (decision 0033); absent when the file stopped first. */
  readonly login?: 'password' | 'private-key';
  /** Its uploads, once its source folders were read; absent when its config stopped first. */
  readonly uploads?: readonly UploadCheck[];
  /**
   * Its `pull:` folders that a mirrored mapping would delete, since no `exclude` covers them
   * (decision 0030, ruling 2); absent when there is none.
   */
  readonly mirroredPulls?: readonly MirroredPull[];
}

/** A `pull:` folder inside a mirrored folder that no `exclude` covers (decision 0030). */
export interface MirroredPull {
  readonly pull: PullEntry;
  /** The path from the config folder that an `exclude` pattern would name to keep it. */
  readonly exclude: string;
}

/** What `sealup check [target]` found. */
export interface CheckReport {
  /** The config file, absolute. */
  readonly configFile: string;
  /** The env file read besides the environment, absolute. */
  readonly envFile: string;
  /** A target was named: only it is checked, and its problem is an error, not a warning. */
  readonly named: boolean;
  /** The targets checked, in file order. */
  readonly targets: readonly TargetCheck[];
  /**
   * The named target's code; without a name, 0 when at least one target is ready, else the
   * first target's (decision 14).
   */
  readonly exitCode: ExitCode;
}

// ---------------------------------------------------------------------------------------------
// `sealup keyscan` (spec #24 decision 18, S04): one result of facts, not a run with progress.
// ---------------------------------------------------------------------------------------------

/** What `sealup keyscan [target]` found: the key the server shows, against the saved one. */
export interface KeyscanReport {
  /** The config file, absolute. */
  readonly configFile: string;
  readonly target: string;
  readonly server: ServerUrl;
  /** The key the server showed. */
  readonly shown: ScannedHostKey;
  /** The key sealup.yml holds for the target, and its place; absent when it holds none. */
  readonly saved?: { readonly key: HostKeyId; readonly place: ConfigPlace };
  /** `not-saved`: none is; `same`: the shown key is; `other`: another key is. */
  readonly state: 'not-saved' | 'same' | 'other';
}

/**
 * What `sealup keyscan [target]` found on an `ftps://` target (spec #41 decision 12): the
 * certificate the server shows, what the normal check says, against the pinned one.
 */
export interface CertificateReport {
  readonly configFile: string;
  readonly target: string;
  readonly server: ServerUrl;
  readonly shown: CertificateScan;
  /** The `tlsFingerprint` sealup.yml holds for the target, and its place; absent when none. */
  readonly saved?: { readonly sha256: string; readonly place: ConfigPlace };
  /**
   * `trusted`: nothing pinned, and the normal check passes (nothing to pin); `not-saved`: nothing
   * pinned, and the normal check fails (a pin is offered); `same`: the pin is this certificate;
   * `other`: the pin is another one.
   */
  readonly state: 'trusted' | 'not-saved' | 'same' | 'other';
}

// ---------------------------------------------------------------------------------------------
// Exit codes (decision 0023, item 8): each tells whether the server changed.
// ---------------------------------------------------------------------------------------------

export const ExitCode = {
  /** Done, or nothing to do. */
  ok: 0,
  /**
   * Stopped part-way; running the same command again finishes the job. Also an error sealup did
   * not expect (0023 has no other code), whose state line says whether anything changed.
   */
  partial: 1,
  /** Usage or config problem; nothing was sent. */
  usage: 2,
  /** Login refused, never retried. */
  auth: 3,
  /** Server identity not confirmed (host key missing or changed, or TLS certificate refused). */
  hostKey: 4,
  /** Unreachable before any change. */
  unreachable: 5,
  /** Stopped by a safety net (empty or missing source, symlink). */
  safetyNet: 6,
  /** Interrupted (Ctrl-C). */
  interrupted: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
