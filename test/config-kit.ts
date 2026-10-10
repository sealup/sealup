// Fixtures for config tests (loadConfig, decision 0022): a sealup.yml and its files in a fresh
// temp folder (its path holds a space), and the issues or targets it resolves to.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { type ConfigResult, loadConfig } from '../src/config/index.ts';
import type { ConfigIssue, Target } from '../src/contracts/index.ts';

/** `${NAME}`, the variable reference sealup.yml uses (built, so it reads as config, not code). */
export const ref = (name: string): string => `$\{${name}}`;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** An empty temp folder (its name holds a space), removed after the test. */
export function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'sealup config '));
  folders.push(folder);
  return folder;
}

/** Loads `yaml` as sealup.yml from a temp folder holding `files`, removed after the test. */
export async function load(
  yaml: string,
  env: Record<string, string> = { SEALUP_PASSWORD: 'pw-1234' },
  files: Readonly<Record<string, string>> = {},
): Promise<{ result: ConfigResult; folder: string; file: string }> {
  const folder = tempFolder();
  const file = join(folder, 'sealup.yml');
  writeFileSync(file, yaml);
  for (const [path, content] of Object.entries(files)) {
    const full = join(folder, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { result: await loadConfig(file, env), folder, file };
}

/** The issues of a config that stops every run. */
export function issuesOf(result: ConfigResult): readonly ConfigIssue[] {
  if (result.ok) throw new Error('expected config issues');
  return result.issues;
}

/** The resolved target `name`; fails the test when the file or the target has problems. */
export function targetOf(result: ConfigResult, name: string): Target {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const entry = result.config.targets.get(name);
  if (entry === undefined) throw new Error(`no target ${name}`);
  if (!entry.ok) throw new Error(JSON.stringify(entry.issues));
  return entry.target;
}

/** The issues that stop a run to target `name` (the file itself is fine). */
export function targetIssues(result: ConfigResult, name: string): readonly ConfigIssue[] {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const entry = result.config.targets.get(name);
  if (entry === undefined) throw new Error(`no target ${name}`);
  if (entry.ok) throw new Error(`expected issues for ${name}`);
  return entry.issues;
}
