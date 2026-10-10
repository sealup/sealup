// Writes `schema.json`, the JSON Schema (draft-07) of sealup.yml, generated from the config
// module's zod/mini schema (decision 0012). It sits at the package root, is committed and is
// shipped in the npm package, so an editor can check a config against it. The build writes it;
// a unit test fails when the committed file differs from what the schema generates.
//
//   node scripts/schema.ts   write schema.json (only when it changed)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configJsonSchema } from '../src/config/index.ts';
import { repoRoot } from './gates.ts';

export const schemaFile: string = join(repoRoot, 'schema.json');

/** The text of schema.json: two-space JSON and a final line break. */
export function schemaText(): string {
  return `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
}

/** Writes schema.json when its text changed (so a parallel reader never sees a half file). */
export function writeSchema(): boolean {
  const text = schemaText();
  let old: string | undefined;
  try {
    old = readFileSync(schemaFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (old === text) return false;
  writeFileSync(schemaFile, text);
  return true;
}

if (import.meta.main) {
  console.log(writeSchema() ? 'wrote schema.json' : 'schema.json is up to date');
}
