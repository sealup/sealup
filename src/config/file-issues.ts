// The problems of the file itself, which stop every run: the schema's issues turned into ours
// (words are report's, places are ours, never the input), the `$` forms sealup does not read,
// with login values (password, private key, passphrase) and `write` values that are not one
// `${VAR}` reference (R3), and a target that does not log in exactly one way (decision 0033).

import type * as z from 'zod/mini';
import type { ConfigIssue, ConfigPlace, Secret } from '../contracts/index.ts';
import { createFileSecret, createSecret } from '../secret/index.ts';
import { referenceOf, validSyntax } from './interpolate.ts';
import { isMapping, isRecord, type Path } from './place.ts';
import { expectedAt } from './schema.ts';
import { isWriteValue, literalWriteSecret } from './write.ts';

/** The login keys, each one `${VAR}` reference only (R3; decision 0033). */
const loginKeys = ['password', 'privateKey', 'passphrase'] as const;

/**
 * `$` forms sealup does not read, and login values (password, private key, passphrase) that are
 * not one `${VAR}` reference (R3). Interpolation is on string values only: keys and numbers are
 * never touched.
 */
export function syntaxIssues(
  data: Record<string, unknown>,
  place: (path: Path) => ConfigPlace,
  secrets: Secret[],
) {
  const issues: ConfigIssue[] = [];
  const owners: Path[] = [[]];
  if (isMapping(data.targets)) {
    for (const name of Object.keys(data.targets)) owners.push(['targets', name]);
  }
  /** The login key at `path`, if it is one. */
  const loginKeyAt = (path: Path): (typeof loginKeys)[number] | undefined => {
    const key = path.at(-1);
    const owner = path.slice(0, -1);
    const owned = owners.some(
      (o) => o.length === owner.length && o.every((part, i) => part === owner[i]),
    );
    return owned ? loginKeys.find((login) => login === key) : undefined;
  };
  const walk = (value: unknown, path: Path): void => {
    if (typeof value === 'string') {
      const login = loginKeyAt(path);
      if (login !== undefined) {
        if (referenceOf(value) === undefined) {
          issues.push({
            code: 'secret-in-config',
            ...place(path),
            ...(login === 'password' ? {} : { detail: login }),
          });
          // Never printed; made a Secret so GitHub masks it too (S15's first mask line). A key
          // keeps its line breaks: each of its lines is masked.
          const literal =
            login === 'privateKey'
              ? createFileSecret(path.join('.'), value)
              : createSecret(path.join('.'), value);
          if (literal.ok) secrets.push(literal.secret);
        }
      } else if (isWriteValue(path)) {
        // A file written from a secret takes exactly one `${VAR}` (R3), never its content.
        if (referenceOf(value) === undefined) {
          issues.push({ code: 'secret-in-config', ...place(path), detail: 'write' });
          const literal = literalWriteSecret(path, value);
          if (literal !== undefined) secrets.push(literal);
        }
      } else if (!validSyntax(value)) issues.push({ code: 'variable-syntax', ...place(path) });
    } else if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) walk(item, [...path, i]);
    } else if (isMapping(value)) {
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    }
  };
  walk(data, []);
  return issues;
}

/**
 * Each target logs in one way (decision 0033): exactly one of `password` and `privateKey`, and a
 * `passphrase` only with the key. A problem of the file, like a missing key.
 */
export function loginIssues(
  data: Record<string, unknown>,
  place: (path: Path) => ConfigPlace,
): ConfigIssue[] {
  const owners: [Record<string, unknown>, Path][] = [];
  if (isMapping(data.targets)) {
    for (const [name, target] of Object.entries(data.targets)) {
      if (isMapping(target)) owners.push([target, ['targets', name]]);
    }
  } else if (!Object.hasOwn(data, 'targets')) owners.push([data, []]);
  const issues: ConfigIssue[] = [];
  for (const [target, at] of owners) {
    const has = (key: string): boolean => Object.hasOwn(target, key);
    if (has('password') && has('privateKey')) {
      issues.push({
        code: 'login',
        ...place([...at, 'privateKey']),
        detail: 'both',
        other: place([...at, 'password']),
      });
    } else if (!has('password') && !has('privateKey')) {
      issues.push({ code: 'login', ...place(at), detail: 'none' });
    }
    if (has('passphrase') && !has('privateKey')) {
      issues.push({ code: 'login', ...place([...at, 'passphrase']), detail: 'passphrase-alone' });
    }
  }
  return issues;
}

/** Turns one zod issue into ours: words are report's, places are ours (never the input). */
export function schemaIssues(
  issue: z.core.$ZodIssue,
  data: unknown,
  place: (path: Path) => ConfigPlace,
): ConfigIssue[] {
  const path = issue.path.filter((key): key is string | number => typeof key !== 'symbol');
  // A `write` or `upload` entry in the long form: its own key's issue (the mode, `mirror`, a key it
  // does not take), not "the entry is wrong", so the line is the one to fix.
  if (issue.code === 'invalid_union' && isEntry(path) && isMapping(valueAt(data, path))) {
    // The long form's issues: those of the option that took a mapping (not "expected text").
    const nested = issue.errors.find(
      (errors) => !errors.some((inner) => inner.code === 'invalid_type' && inner.path.length === 0),
    );
    if (nested !== undefined) {
      return nested.flatMap((inner) =>
        schemaIssues({ ...inner, path: [...path, ...inner.path] }, data, place),
      );
    }
  }
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({ code: 'unknown-key', ...place([...path, key]) }));
  }
  if (valueAt(data, path) === undefined) return [{ code: 'missing-key', ...place(path) }];
  const expected = expectedAt(path, issue.code === 'invalid_key');
  return [{ code: 'wrong-type', ...place(path), expected }];
}

/** One `write` entry, the `upload` map or one of its entries (under `targets.<name>` or not). */
function isEntry(path: Path): boolean {
  const [first] = path;
  const [key, ...below] = first === 'targets' ? path.slice(2) : path;
  return key === 'upload' ? below.length <= 1 : key === 'write' && below.length === 1;
}

function valueAt(data: unknown, path: Path): unknown {
  let value = data;
  for (const key of path) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
