// contracts, the local side, the manifest and the plan: what `scan` finds, what the manifest
// records, and what plan() takes and gives. Additions here: a PlanOp, a PlanBlock, a field of
// the local tree or of the plan. A new manifest field is format 2 (decision 0026).

import type { RemotePath, ServerPath, Sha256 } from './brands.ts';
import type { AllowedRisk, Mapping } from './config.ts';

// ---------------------------------------------------------------------------------------------
// The local side, the manifest and the plan.
// ---------------------------------------------------------------------------------------------

/** A file in a local source folder, ready to upload. */
export interface LocalFile {
  /** Absolute local path. */
  readonly abs: string;
  readonly size: number;
  readonly sha256: Sha256;
}

/** Every local file of a target, keyed by where it goes (R11: a Map, never a plain object). */
export type LocalTree = ReadonlyMap<RemotePath, LocalFile>;

/** What the manifest knows about one file sealup uploaded. */
export interface FileRecord {
  readonly size: number;
  readonly sha256: Sha256;
}

/**
 * What sealup uploaded to one target folder (format 2, decisions 0007 and 0032). Format 1 is
 * still read, as a manifest with no pending names; a later format is refused.
 */
export interface Manifest {
  readonly format: 2;
  /** The absolute target folder this manifest describes. */
  readonly folder: ServerPath;
  readonly files: ReadonlyMap<RemotePath, FileRecord>;
  /**
   * Temp names (`.<name>.sealup-<16 hex>.tmp`) a run may have left in the target folder: uploads
   * in flight when it was written, or left by a failure. The next run removes them first (R18).
   */
  readonly pending: readonly RemotePath[];
}

/**
 * Why a manifest cannot be trusted (R12, R21): the server would not let sealup read it (refused,
 * or not a file); it is not a valid format 1 or 2 manifest of this target folder (bad JSON,
 * another version, an unknown key, a path outside the folder, a pending name that is not a temp
 * name); or it is over the size limit. Exported for
 * the run's Problem only: the entry file does not re-export it.
 */
export type ManifestProblem = 'unreadable' | 'invalid' | 'too-large';

/**
 * The manifest as read from the server. `absent` is a first deploy; `unusable` (unreadable,
 * invalid, over the size limit) stops the run, nothing is deleted (R12).
 */
export type ManifestRead =
  | { readonly kind: 'found'; readonly manifest: Manifest }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unusable'; readonly reason: ManifestProblem };

/** A source folder that is missing or would send no file (every file excluded counts too). */
export interface EmptySource {
  readonly mapping: Mapping;
  /** The folder does not exist (rather than holding no file to send). */
  readonly missing: boolean;
}

export interface PlanInput {
  readonly local: LocalTree;
  readonly remote: ManifestRead & { readonly kind: 'found' | 'absent' };
  /** The target's mappings: a manifest path goes back through them to meet the excludes. */
  readonly uploads: readonly Mapping[];
  /** The target's `exclude` patterns (Target.exclude). */
  readonly exclude: readonly string[];
  /** The source folders that are missing or send nothing (scan), in mapping order (R20). */
  readonly emptySources: readonly EmptySource[];
  /** The safety nets the target turns off on purpose (Target.allow). */
  readonly allow: ReadonlySet<AllowedRisk>;
  /**
   * The files written from a secret (Target.writes), each with what deploy found by reading the
   * server file back. Never deleted, never recorded (owner ruling 8). None when absent.
   */
  readonly writes?: readonly WriteRead[];
  /**
   * What the server check found (`--check-server`, spec #41 decision 26); absent when it is off.
   * A file the manifest records with the build's SHA-256 is uploaded again when the server lacks
   * it, holds it with another size, or dates it later than the manifest file.
   */
  readonly server?: ServerCheck;
  /**
   * The links in the source folders that `allow: [symlinks]` lets the run skip (scan never
   * followed them): from the config folder, `/`-separated, in path order. None when absent.
   */
  readonly skipped?: readonly string[];
  /**
   * Recorded paths the server holds as a link or behind one, found by deploy under
   * `allow: [symlinks]`: never deleted, kept (reason `link`). None when absent.
   */
  readonly linked?: ReadonlySet<RemotePath>;
  /**
   * What the full mirror listed (decision 0030): every listed file not in the build is deleted
   * (reason `not-in-build`), then every listed folder left holding nothing that stays. None
   * when no mapping is mirrored.
   */
  readonly mirror?: MirrorListing;
}

/**
 * The mirrored server folders as the listing found them, below each mirrored folder; excluded
 * paths, and whatever sits below an excluded folder or a link, are never in it.
 */
export interface MirrorListing {
  /** The regular files, by path. */
  readonly files: ReadonlySet<RemotePath>;
  /** The real folders. */
  readonly folders: ReadonlySet<RemotePath>;
  /** The links, left alone and kept (reason `link`): only with `allow: [symlinks]`. */
  readonly links: ReadonlySet<RemotePath>;
  /**
   * Folders that hold something the mirror leaves alone (an excluded path, a socket, a name no
   * path can hold): they stay, and so do the folders above them.
   */
  readonly held: ReadonlySet<RemotePath>;
}

/**
 * The tool-owned files as the server lists them, and the manifest file's own date: one listing
 * of the folders that hold tool-owned files, so both dates come from the server's clock.
 */
export interface ServerCheck {
  /** The regular files those folders hold, by path; a recorded path not here is missing. */
  readonly files: ReadonlyMap<RemotePath, ListedFile>;
  /**
   * The manifest file's modification time, whole seconds since 1970; undefined when its folder's
   * listing did not show it (then only the size and a missing file count).
   */
  readonly manifestMtime: number | undefined;
}

/** A file as a server listing gives it. */
export interface ListedFile {
  readonly size: number;
  /** Whole seconds since 1970, on the server's clock. */
  readonly mtime: number;
}

/** A file written from a secret, as deploy found it on the server before planning. */
export interface WriteRead {
  readonly path: RemotePath;
  /** The variable it comes from: what the dry run shows instead of a size (never the value). */
  readonly from: string;
  /** `same`: the server file holds the secret's value; `different`: it holds something else. */
  readonly found: 'same' | 'different' | 'absent';
}

/** One step of a plan; paths are relative to the target folder. */
export type PlanOp =
  | { readonly op: 'mkdir'; readonly path: RemotePath }
  /**
   * `new`: not in the manifest; `changed`: another SHA-256 than the manifest's; `changed-on-server`:
   * the build's file is the one recorded, but the server check found it missing, of another size,
   * or dated after the manifest (spec #41 decision 26).
   */
  | {
      readonly op: 'upload';
      readonly path: RemotePath;
      readonly reason: 'new' | 'changed' | 'changed-on-server';
      readonly size: number;
      readonly sha256: Sha256;
    }
  /**
   * A file written from a secret, which the server lacks (`new`) or holds otherwise (`changed`).
   * No size, no content: `from` is the variable's name.
   */
  | {
      readonly op: 'write';
      readonly path: RemotePath;
      readonly reason: 'new' | 'changed';
      readonly from: string;
    }
  /**
   * `left-build`: a file sealup uploaded before that left the build (R13); `not-in-build`: a file
   * the full mirror listed that sealup never recorded (decision 0030).
   */
  | {
      readonly op: 'delete';
      readonly path: RemotePath;
      readonly reason: 'left-build' | 'not-in-build';
    }
  /** A folder that held deleted files and is no longer in the build; left alone if not empty. */
  | { readonly op: 'rmdir'; readonly path: RemotePath };

/**
 * A recorded file that left the build and is not deleted, or a link the full mirror listed
 * (decision 0030), and why (the dry run lists them): `excluded` now, or `link`: the server holds
 * it as a link, or behind one, and `allow: [symlinks]` leaves server links alone (spec #41
 * decision 28).
 */
export interface KeptFile {
  readonly path: RemotePath;
  readonly reason: 'excluded' | 'link';
}

/**
 * What a deploy will do. Ops in order: mkdirs (parents first), uploads, writes, deletes, rmdirs
 * (deepest first); in path order within each group. Before them, the deletes and rmdirs that
 * make way, when the build needs a path a recorded entry holds as the other kind (S1).
 */
export interface Plan {
  readonly ops: readonly PlanOp[];
  /**
   * Local files the manifest already records with the same SHA-256, and files written from a
   * secret the server already holds as they are.
   */
  readonly unchanged: number;
  /**
   * The size of the unchanged files, bytes (the job summary's counts table); a secret's size is
   * never counted.
   */
  readonly unchangedBytes: number;
  /** Bytes to upload (a secret's size is never counted). */
  readonly bytes: number;
  /** Files that left the build, or links the mirror listed, that stay on the server; path order. */
  readonly kept: readonly KeptFile[];
  /**
   * Links in the source folders, skipped and never followed (`allow: [symlinks]`, spec #41
   * decision 28): from the config folder, `/`-separated, in path order. Nothing is sent for them.
   */
  readonly skipped: readonly string[];
  /** No manifest yet: existing files stay, deleted only by the mirror (decisions 0008, 0030). */
  readonly firstDeploy: boolean;
  /** Present when nothing of the plan may be applied: a safety net stops the run (exit 6). */
  readonly blocked?: PlanBlock;
}

/** Why nothing of a plan may be applied. */
export type PlanBlock =
  /** R20: a source folder is missing or sends nothing, and the target does not allow it. */
  | { readonly reason: 'empty-source'; readonly source: EmptySource }
  /**
   * The build needs `path` as one kind, and a recorded file sealup keeps (excluded) holds it:
   * the kept file itself (`found: 'file'`, where a folder is needed), or a kept file inside a
   * recorded folder (`found: 'folder'`, where a file is needed).
   */
  | {
      readonly reason: 'in-the-way';
      readonly path: RemotePath;
      readonly found: 'file' | 'folder';
    };
