// contracts, `sealup pull` (spec #24 decisions 7 and 25): what a pull tells the outside. Its own
// event union and reporter port, so no deploy reporter has to learn pull events; it ends with the
// same Outcome as a deploy (its `downloaded` set). Additions here: a pull event, a plan field.

import type { ServerPath } from './brands.ts';
import type { PullEntry, Target } from './config.ts';
import type { HostKeyCheck, Outcome, Progress, RunWarning } from './run.ts';

/** One file a pull copies here: new, or replacing a local file of another size or date. */
export interface PullDownload {
  /** Where the server holds it, absolute. */
  readonly from: ServerPath;
  /** Where it goes, from the folder of sealup.yml, `/`-separated. */
  readonly to: string;
  readonly size: number;
  /** The server's modification time, whole seconds: the local file gets it too. */
  readonly mtime: number;
  readonly reason: 'new' | 'replace';
}

/** What a pull found, before it writes anything here. */
export interface PullPlan {
  /** The target's pull entries, in config order. */
  readonly entries: readonly PullEntry[];
  /** The files to copy here, in path order (by `to`). */
  readonly downloads: readonly PullDownload[];
  /** Files already here, unchanged: the same size and modification time (in whole seconds). */
  readonly unchanged: number;
  /** The bytes to download. */
  readonly bytes: number;
  /** Links on the server, skipped: a pull never follows one. */
  readonly links: number;
  /** Sockets, devices and pipes on the server, skipped. */
  readonly special: number;
}

/**
 * What happens during a pull, in order: `start` (the target is chosen), `host-key`, `plan` (the
 * server listed and every name and local path checked), `progress` after each file that arrived,
 * then always `done`. A pull that stops before `start` sends only `done`.
 */
export type PullEvent =
  | {
      readonly type: 'start';
      readonly target: Target;
      readonly configFile: string;
      /** `--dry-run`: it lists and compares, then stops, writing nothing. */
      readonly dryRun: boolean;
      /** What this pull risks without stopping, printed after the target block (S23). */
      readonly warnings: readonly RunWarning[];
    }
  | ({ readonly type: 'host-key' } & HostKeyCheck)
  | { readonly type: 'plan'; readonly plan: PullPlan }
  | ({ readonly type: 'progress' } & Progress)
  | { readonly type: 'done'; readonly outcome: Outcome };

/** Takes the events of a pull (terminal and JSON reporters). */
export interface PullReporter {
  on(event: PullEvent): void;
}
