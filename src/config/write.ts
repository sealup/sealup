// The `write` entries of a target (decisions 0004, 0022 §2 and §8; R3, R17; spec #24 decision
// 24): a server file written from a secret. Short form `remote: ${VAR}`, long form with `from`,
// `mode` (an octal string, default '0600') and `allowPublic` (default false). The schema pass and
// the syntax pass already refused a value that is not one `${VAR}` (secret-in-config, for every
// run); what is left depends on the environment, so it stops only a run to this target.

import type { ConfigIssue, ConfigPlace, Secret, SecretFile } from '../contracts/index.ts';
import { parseRemotePath } from '../paths/index.ts';
import { createFileSecret } from '../secret/index.ts';
import { referenceOf } from './interpolate.ts';
import type { WriteInput } from './schema.ts';

type Path = readonly (string | number)[];

/** R17's default: readable and writable by the account that owns the file, by nobody else. */
const defaultMode = 0o600;

interface WriteContext {
  /** The value with its variables filled in, or undefined after reporting the unset one. */
  readonly fill: (text: string, path: Path) => string | undefined;
  readonly place: (path: Path) => ConfigPlace;
  /** Every Secret made while loading: the masks (R2). */
  readonly secrets: Secret[];
}

/** One target's files written from a secret, the shared list first; issues go to `issues`. */
export function resolveWrites(
  lists: readonly (readonly [write: WriteInput, path: Path])[],
  issues: ConfigIssue[],
  context: WriteContext,
): SecretFile[] {
  const files: SecretFile[] = [];
  for (const [write, at] of lists) {
    for (const [remote, entry] of Object.entries(write)) {
      const path = [...at, remote];
      const place = context.place(path);
      const long = typeof entry !== 'string';
      const from = long ? entry.from : entry;
      const fromPath = long ? [...path, 'from'] : path;
      const parsed = parseRemotePath(remote);
      if (!parsed.ok) {
        issues.push({ code: 'remote-path', ...place, detail: 'file' });
        continue;
      }
      const reference = referenceOf(from);
      const value = reference === undefined ? undefined : context.fill(from, fromPath);
      if (reference === undefined || value === undefined) continue;
      const made = createFileSecret(reference.variable, value);
      if (!made.ok) {
        const reason = 'too-short';
        issues.push({ code: 'secret-refused', ...place, variable: reference.variable, reason });
        continue;
      }
      context.secrets.push(made.secret);
      files.push({
        path: parsed.path,
        secret: made.secret,
        mode: long && entry.mode !== undefined ? Number.parseInt(entry.mode, 8) : defaultMode,
        allowPublic: long && entry.allowPublic === true,
        place,
      });
    }
  }
  return files;
}

/**
 * Where a config holds a `write` value: `write.<path>` (short form) and `write.<path>.from`, at
 * the top level and in each target. The syntax pass refuses one that is not a single `${VAR}`.
 */
export function isWriteValue(path: Path): boolean {
  const [first] = path;
  const rest = first === 'targets' ? path.slice(2) : path;
  // A list under `write` is wrong-type, not an entry.
  if (rest[0] !== 'write' || typeof rest[1] !== 'string') return false;
  return rest.length === 2 || (rest.length === 3 && rest[2] === 'from');
}

/**
 * The value a literal `write` entry would write, made a Secret so GitHub masks it too (as a
 * literal password is): it is in the file, so it may be in the log's neighbourhood.
 */
export function literalWriteSecret(path: Path, value: string): Secret | undefined {
  const made = createFileSecret(path.join('.'), value);
  return made.ok ? made.secret : undefined;
}
