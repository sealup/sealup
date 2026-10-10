// The variables `${VAR}` may name (decision 0022 §7): the environment, plus `sealup.env` next to
// the config when it exists, or the file given with `--env-file` instead (then it must exist).
// A variable already set in the environment wins; an empty one counts as not set, so the file
// fills it. Read with util.parseEnv into a new object: process.env is never changed (ruling 13),
// and a plain `.env` is never read.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

/** Environment variables: the process's, or a test's (injected, never process.env itself). */
export type Env = Readonly<Record<string, string | undefined>>;

export type EnvResult =
  | {
      readonly ok: true;
      readonly env: Env;
      readonly file: string;
      /** The variables whose value comes from the file, not the environment (`check`, S06). */
      readonly fromFile: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly file: string };

/** The env file sealup reads for a config file when no `--env-file` is given. */
function defaultEnvFile(configFile: string): string {
  return join(dirname(configFile), 'sealup.env');
}

export async function loadEnv(
  configFile: string,
  env: Env,
  envFile: string | undefined,
): Promise<EnvResult> {
  const file = envFile ?? defaultEnvFile(configFile);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return envFile === undefined
      ? { ok: true, env, file, fromFile: new Set() }
      : { ok: false, file };
  }
  // No prototype: a variable named __proto__ is just a name (R11).
  const merged: Record<string, string | undefined> = Object.assign(
    Object.create(null),
    parseEnv(text),
  );
  const fromFile = new Set(Object.keys(merged));
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') {
      merged[name] = value;
      fromFile.delete(name);
    } else if (!Object.hasOwn(merged, name)) merged[name] = value;
  }
  return { ok: true, env: merged, file, fromFile };
}
