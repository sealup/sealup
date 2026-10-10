// The shape of sealup.yml (decisions 0012, 0022), as a zod/mini schema: the source of the
// TypeScript types and of the JSON Schema shipped as `schema.json`. It holds only what this
// version honours, so editors never suggest anything else. Values are checked here as written, before `${VAR}` is filled
// in; what a value means (a URL, a path) is checked after, per target.

import * as z from 'zod/mini';
import { type ConfigExpected, maxFtpConnections } from '../contracts/index.ts';

/** What `allow:` may name in this version. */
const allowed = ['empty-source', 'symlinks', 'root-folder'] as const;

const text = z.string();
const count = z.number().check(z.int(), z.minimum(1), z.maximum(256));
/** `30s`, `2m`: seconds or minutes. */
export const durationPattern = /^([1-9][0-9]{0,5})(s|m)$/;
const duration = z.string().check(z.regex(durationPattern));
/** A name the command line can carry (`sealup deploy <name>`): no space, no control character. */
const targetName = z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/));

/** The server side of one `local: remote` pair: a folder for a folder, a file path for a file. */
const serverSide = text.check(
  z.describe('Server folder (. is the target folder), or file path for a single file'),
);
const uploadEntry = z.union([
  serverSide,
  z.strictObject({
    to: serverSide,
    mirror: z.optional(
      z
        .boolean()
        .check(z.describe('Also delete server files sealup did not upload (minus excludes)')),
    ),
  }),
]);
const upload = z
  .union([text, z.record(text, uploadEntry)])
  .check(
    z.describe(
      'A folder sent to the target folder, or local: server pairs (folders or single files)',
    ),
  );
/** `.gitignore` patterns, written on the local side (ticket 06). */
const exclude = z.optional(z.array(text));

/** A file mode as an octal string (`'0640'`): quoted, so YAML does not read the number 640. */
const modePattern = /^0?[0-7]{3}$/;
/** One `write` entry: the secret alone, or the long form (decision 0022 §8). */
const secretFrom = text.check(z.describe(`A variable only, like $\{APP_ENV}`));
const writeEntry = z.union([
  secretFrom,
  z.strictObject({
    from: secretFrom,
    mode: z.optional(
      z.string().check(z.regex(modePattern), z.describe("File mode, quoted (default '0600')")),
    ),
    allowPublic: z.optional(
      z.boolean().check(z.describe('Write it even into a folder that looks public')),
    ),
  }),
]);
/** Server files written from a secret, in memory, mode 0600 (R17). */
const write = z.optional(
  z
    .record(text, writeEntry)
    .check(z.describe('server file: secret pairs, each file written from a secret, mode 0600')),
);

/** What `sealup pull` copies to this machine: server side, then local side (decision 0002). */
const pull = z.optional(
  z
    .record(text, text.check(z.describe('Local folder (or file), inside the folder of sealup.yml')))
    .check(z.describe('server folder (or file): local folder pairs, for sealup pull')),
);

/** Keys a target may set for itself, or the top level for every target. */
const tune = {
  parallel: z.optional(
    count.check(
      z.describe(
        `SFTP requests in flight (default 64); FTP connections (default 4, at most ${maxFtpConnections})`,
      ),
    ),
  ),
  timeout: z.optional(duration.check(z.describe('Per operation, like 30s or 2m (default 30s)'))),
  manifest: z.optional(
    text.check(z.describe('Manifest folder, from the login folder (default .sealup)')),
  ),
};

/**
 * Keys of one target: where it goes and how sealup logs in, with exactly one of `password` and
 * `privateKey` (decision 0033: checked by the loader, so each key's own problem has its line).
 */
const connection = {
  server: text.check(
    z.describe('sftp|ssh|ftps|ftp://user@host[:port]/folder (/~/… is in the login folder)'),
  ),
  password: z.optional(
    text.check(z.describe(`A variable only, like $\{SEALUP_PASSWORD}; or privateKey`)),
  ),
  privateKey: z.optional(
    text.check(z.describe(`A variable holding the key file, like $\{DEPLOY_KEY}; or password`)),
  ),
  passphrase: z.optional(
    text.check(z.describe(`A variable only, like $\{KEY_PASSPHRASE}, for an encrypted key`)),
  ),
  hostKey: z.optional(text.check(z.describe('The OpenSSH public key line keyscan writes'))),
  tlsFingerprint: z.optional(
    text.check(
      z.describe(
        "ftps only: the certificate's SHA-256 (AA:BB:…, 32 pairs) that keyscan writes; it replaces the CA and host name checks",
      ),
    ),
  ),
  url: z.optional(text.check(z.describe('The site address, shown after a deploy'))),
  allow: z.optional(z.array(z.enum(allowed))),
  checkServer: z.optional(
    z.boolean().check(z.describe('Put back files changed on the server (default false)')),
  ),
};

/** The one-target shorthand: a target's keys at the top level. */
export const shorthandSchema = z.strictObject({
  ...connection,
  ...tune,
  upload,
  exclude,
  write,
  pull,
});

/**
 * One named target; its own `upload`, `exclude`, `write` and `pull` are added to the shared
 * lists.
 */
const targetSchema = z.strictObject({
  ...connection,
  ...tune,
  upload: z.optional(upload),
  exclude,
  write,
  pull,
});

/** Named targets; the top level holds what they share. */
export const namedSchema = z.strictObject({
  ...tune,
  upload,
  exclude,
  write,
  pull,
  targets: z.record(targetName, targetSchema),
});

/** Keys that belong to one target: at the top level only in the shorthand. */
export const targetOnlyKeys: readonly string[] = Object.keys(connection);

export type ShorthandInput = z.infer<typeof shorthandSchema>;
export type NamedInput = z.infer<typeof namedSchema>;
export type TargetInput = z.infer<typeof targetSchema>;
export type UploadInput = ShorthandInput['upload'];
export type WriteInput = NonNullable<ShorthandInput['write']>;
export type PullInput = NonNullable<ShorthandInput['pull']>;

/**
 * The JSON Schema (draft-07) of sealup.yml, generated from the schemas above (decision 0012).
 * Spec #41 decision 4's maximum for FTP is added by hand, as an if/then on the server's protocol
 * on every shape that holds both keys (the shorthand, a named target), so an editor flags it; the
 * loader checks it too, with its own words.
 */
export function jsonSchema(): Record<string, unknown> {
  const schema = z
    .union([shorthandSchema, namedSchema])
    .check(z.meta({ title: 'sealup.yml', description: 'sealup deploy configuration' }));
  const json = z.toJSONSchema(schema, { target: 'draft-07', io: 'input' });
  const [shorthand, named] = (json.anyOf ?? []) as Record<string, unknown>[];
  const targets = (named?.properties as Record<string, Record<string, unknown>> | undefined)
    ?.targets;
  for (const shape of [shorthand, targets?.additionalProperties]) {
    if (typeof shape === 'object' && shape !== null) Object.assign(shape, ftpMaximum);
  }
  return json;
}

/** `parallel` at most `maxFtpConnections` when `server` is an `ftp://` or `ftps://` URL. */
const ftpMaximum = Object.fromEntries([
  [
    'if',
    { properties: { server: { type: 'string', pattern: '^ftps?://' } }, required: ['server'] },
  ],
  // JSON Schema's own key, not a promise's.
  ['then', { properties: { parallel: { maximum: maxFtpConnections } } }],
]);

/** What the key at `path` takes, for a wrong-type issue. */
export function expectedAt(
  path: readonly (string | number)[],
  keyRefused: boolean,
): ConfigExpected {
  if (path.length === 0) return 'mapping';
  const [first] = path;
  if (first === 'targets') {
    if (path.length === 1) return 'targets';
    if (path.length === 2) return keyRefused ? 'target-name' : 'target';
  }
  const [key, below, field] = first === 'targets' ? path.slice(2) : path;
  if (key === 'upload') {
    if (field === 'mirror') return 'yes-no';
    return below === undefined ? 'upload' : 'upload-entry';
  }
  if (key === 'write') {
    if (field === 'mode') return 'mode';
    if (field === 'allowPublic') return 'yes-no';
    if (field === 'from') return 'text';
    return below === undefined ? 'write' : 'write-entry';
  }
  if (key === 'pull') return below === undefined ? 'pull' : 'text';
  if (key === 'parallel') return 'count';
  if (key === 'timeout') return 'duration';
  if (key === 'allow') return 'allow';
  if (key === 'checkServer') return 'yes-no';
  if (key === 'exclude') return 'patterns';
  return 'text';
}
