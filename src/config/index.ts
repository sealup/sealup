// config: sealup.yml and sealup.env (decisions 0012, 0022).
//
// Decision hidden: where the file is found (current folder up to the repo root), the file format
// (YAML 1.2, duplicate keys refused), the zod/mini schema and the JSON Schema generated from it,
// `${VAR}` / `${VAR:?message}` / `$$` interpolation after parsing, the shorthand vs `targets:`
// shapes, defaults, env file loading, and which keys this version cannot honour yet.
//
// Interface: findConfig(cwd) finds sealup.yml (or sealup.yaml). closestTargetName(typed, names)
// is the did-you-mean for a target name that is not in the file. loadConfig(file, env, options)
// returns the file's targets by name, each resolved or with its issues, or the issues of the
// file itself; every issue has a config place (file, line, key path); either way, with every
// Secret it made, for GitHub's masks (a password written as a literal included, never printed).
// Each target, usable or not, also tells the variables it read that are set and where from (the
// environment or the env file), its hostKey state, its url and host (`check` and `sealup` alone,
// spec #24 decisions 12 and 14). configJsonSchema() is the
// JSON Schema (draft-07) the build ships as `schema.json`. saveHostKey(file, name, keyLine) and
// its pure core withHostKey(text, name, keyLine) save a host key as an edit of one line of the
// text (`keyscan`, `init`: spec #24 decision 18); hostKeyPlaceholder is the comment `init`
// writes in its place, which the edit replaces (save-host-key.ts). For `init` (new-project.ts):
// newConfigText(facts) is the minimal sealup.yml; envSecret(name, value, kind) makes a value bound
// for sealup.env a Secret as soon as it is read, and withEnvVariable(text, secret) adds it to an
// env file in a form the env-file reader gives back (config alone holds its value);
// parseServerUrl reads a server address as `server:` is read; findRepoRoot is the repo root
// findConfig stops at; isFile and isMissing are the file tests findConfig uses, which init reads
// the project with.
//
// Invariants: problems of the file itself (YAML, shape, unknown keys, a literal password, a `$`
// form sealup does not read) stop every run. Problems that depend on the environment or on this
// version's limits (an unset variable, a value that is wrong once filled in, a key not available
// yet) belong to the target they are in, so they stop only a run to that target: a staging
// secret missing in the production job never blocks production. A target logs in with exactly
// one of `password` and `privateKey` (+ `passphrase`), each a `${VAR}` reference, never a
// literal (R3; decision 0033). A variable already set (non-empty) in the environment wins
// over the env file; process.env is never changed. Errors cite places, never values (R6). Keys
// this version cannot honour are reported, never silently ignored.
//
// Must never know: the server, the network, how a deploy runs, how output is printed.
//
// Status (tickets 04, 06, 09): complete for the skeleton. `upload` (`dist`, `local: remote`,
// `local: { to: remote }`) and `exclude` at the top level; a target's own `upload` and `exclude`
// are added to the shared lists (ticket 06); tune keys at the top level, a target's own win.
// Lane C #32: a `local: remote` pair whose local side is a file is a single-file mapping, its
// server side a file path; an exclude pattern that matches one is a target issue naming both.
// Lane C #33: `write` (write.ts), a server file from exactly one `${VAR}`, short and long form,
// top level and per target; a literal is secret-in-config, masked all the same. Lane C #35:
// `pull` (pull.ts), `remote: local` pairs; the local side stays inside the config's folder.
// Plan 05 ticket 01: split by concern. This file reads the file and its shape; target.ts resolves
// one target; file-issues.ts holds the file's own problems; place.ts the key
// paths and their lines. Plan 05 T17: no key or value is planned for later any more (later.ts is
// gone with `allow: [root-folder]`, decision 0029).

import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import type { ConfigIssue, ConfigPlace, Secret } from '../contracts/index.ts';
import { type Env, loadEnv } from './env.ts';
import { loginIssues, schemaIssues, syntaxIssues } from './file-issues.ts';
import { interpolate } from './interpolate.ts';
import { isMapping, lineField, lineOf, type Path, sorted } from './place.ts';
import {
  jsonSchema,
  type NamedInput,
  namedSchema,
  type ShorthandInput,
  shorthandSchema,
  targetOnlyKeys,
} from './schema.ts';
import {
  type Context,
  type ListItem,
  type Lists,
  resolveTarget,
  type TargetResult,
} from './target.ts';

export type { Env } from './env.ts';
export { findConfig, findRepoRoot, isFile, isMissing } from './find.ts';
export {
  type EnvSecret,
  envSecret,
  type NewConfig,
  newConfigText,
  passwordVariable,
  withEnvVariable,
} from './new-project.ts';
export {
  hostKeyPlaceholder,
  saveHostKey,
  saveTlsFingerprint,
  withHostKey,
  withTlsFingerprint,
} from './save-host-key.ts';
export { parseServerUrl } from './server-url.ts';
export { closestTargetName } from './suggest.ts';

export interface ResolvedConfig {
  /** The config file, absolute. */
  readonly file: string;
  /** The env file read besides the environment (sealup.env next to the file, or --env-file). */
  readonly envFile: string;
  /** Every target, by name, in file order: resolved, or with the issues that stop a run to it. */
  readonly targets: ReadonlyMap<string, TargetResult>;
}

/**
 * Every Secret the file gave while loading, for any target, a target that cannot be used
 * included, and a password written as a literal (secret-in-config): GitHub's masks (R2).
 */
interface LoadedSecrets {
  readonly secrets: readonly Secret[];
}

export type ConfigResult =
  | ({ readonly ok: true; readonly config: ResolvedConfig } & LoadedSecrets)
  | ({ readonly ok: false; readonly issues: readonly ConfigIssue[] } & LoadedSecrets);

export interface LoadOptions {
  /** `--env-file`: read this file instead of sealup.env next to the config. */
  readonly envFile?: string;
}

/** The JSON Schema (draft-07) of sealup.yml, shipped as `schema.json`. */
export function configJsonSchema(): Record<string, unknown> {
  return jsonSchema();
}

/** Reads and checks a config file; `env` holds the variables `${VAR}` may name. */
export async function loadConfig(
  file: string,
  env: Env,
  options: LoadOptions = {},
): Promise<ConfigResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fail([{ code: 'file-not-found', file, keyPath: '' }]);
  }
  const vars = await loadEnv(file, env, options.envFile);
  if (!vars.ok) return fail([{ code: 'env-file-not-found', file: vars.file, keyPath: '' }]);

  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length > 0) {
    // The parser's message quotes the source line, which may hold a secret (R6): keep its code.
    return fail(
      doc.errors.map((error) => ({
        code: 'yaml',
        file,
        ...lineField(error.linePos?.[0]?.line),
        keyPath: '',
        detail: error.code,
      })),
    );
  }

  const place = (path: Path): ConfigPlace => ({
    file,
    ...lineField(lineOf(doc, lines, path)),
    keyPath: path.join('.'),
  });
  const data: unknown = doc.toJS({ maxAliasCount: 100 }) ?? {};
  if (!isMapping(data)) return fail([{ code: 'wrong-type', ...place([]), expected: 'mapping' }]);

  const issues: ConfigIssue[] = [];
  const secrets: Secret[] = [];
  const named = 'targets' in data;
  if (named) {
    for (const key of targetOnlyKeys.filter((k) => Object.hasOwn(data, k))) {
      issues.push({ code: 'shorthand-with-targets', ...place([key]) });
      delete data[key];
    }
  }
  const checked = (named ? namedSchema : shorthandSchema).safeParse(data);
  if (!checked.success) {
    issues.push(...checked.error.issues.flatMap((issue) => schemaIssues(issue, data, place)));
  }
  issues.push(...syntaxIssues(data, place, secrets));
  issues.push(...loginIssues(data, place));
  if (named && isMapping(data.targets) && Object.keys(data.targets).length === 0) {
    issues.push({ code: 'no-targets', ...place(['targets']) });
  }
  if (issues.length > 0 || !checked.success) return fail(issues, secrets);

  const context: Context = {
    folder: dirname(file),
    env: vars.env,
    envFile: vars.file,
    fromFile: vars.fromFile,
    place,
    secrets,
  };
  const targets = new Map<string, TargetResult>();
  if ('targets' in checked.data) {
    const { targets: entries, ...shared } = checked.data as NamedInput;
    for (const [name, input] of Object.entries(entries)) {
      const own = (key: string): Path =>
        Object.hasOwn(input, key) ? ['targets', name, key] : [key];
      // Tune keys: the target's own wins. Lists: the target's own are added (ticket 06).
      const lists: Lists = {
        uploads: [
          [shared.upload, ['upload']],
          ...(input.upload === undefined
            ? []
            : [[input.upload, ['targets', name, 'upload']] as const]),
        ],
        exclude: [
          ...(shared.exclude ?? []).map((text, i): ListItem => [text, ['exclude', i]]),
          ...(input.exclude ?? []).map(
            (text, i): ListItem => [text, ['targets', name, 'exclude', i]],
          ),
        ],
        writes: [
          ...(shared.write === undefined ? [] : [[shared.write, ['write']] as const]),
          ...(input.write === undefined
            ? []
            : [[input.write, ['targets', name, 'write']] as const]),
        ],
        pulls: [
          ...(shared.pull === undefined ? [] : [[shared.pull, ['pull']] as const]),
          ...(input.pull === undefined ? [] : [[input.pull, ['targets', name, 'pull']] as const]),
        ],
      };
      const merged = { ...shared, ...input };
      targets.set(name, await resolveTarget(name, merged, lists, own, context));
    }
  } else {
    const input = checked.data as ShorthandInput;
    const name = shorthandName(input.server, context.env);
    const lists: Lists = {
      uploads: [[input.upload, ['upload']]],
      exclude: (input.exclude ?? []).map((text, i): ListItem => [text, ['exclude', i]]),
      writes: input.write === undefined ? [] : [[input.write, ['write']]],
      pulls: input.pull === undefined ? [] : [[input.pull, ['pull']]],
    };
    targets.set(name, await resolveTarget(name, input, lists, (key) => [key], context));
  }
  return { ok: true, config: { file, envFile: vars.file, targets }, secrets };
}

/** The shorthand target is named after the server's host (ruling 4), even when the URL is bad. */
function shorthandName(server: string, env: Env): string {
  const filled = interpolate(server, env);
  const text = filled.ok ? filled.value : server;
  const host = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/]*@/, '')
    .replace(/[:/].*$/s, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) ? host : 'default';
}

function fail(issues: readonly ConfigIssue[], secrets: readonly Secret[] = []): ConfigResult {
  return { ok: false, issues: sorted(issues), secrets };
}
