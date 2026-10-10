// Another worktree in `.worktrees/` is invisible to every gate (spec sealup/sealup#24 decision 1,
// ruling 6): a temp project with `.worktrees/x/` holding its own `biome.json` and a file that
// breaks every gate passes them all, and the same file outside `.worktrees/` fails each one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GateName, gateNames, repoRoot } from '../../scripts/gates.ts';
import { type GateRun, makeProject, type ProjectFile, removeProject, runGate } from './gate-kit.ts';

/** One file that every gate refuses. */
const badFile = [
  "import { it, expect } from 'vitest'", // Biome: imports out of order, format
  // Import rules: entry-only; tsc: TS2307. Split, so the rules don't read it in this file.
  `import { plan } from '../../src/plan/${'rules'}.ts';`,
  '',
  "export const unusedExport: number = 'text';", // knip: unused export; tsc: TS2322
  'export function first(values: any): unknown { return values; }', // Biome: noExplicitAny
  '',
  "it.only('fails', () => { expect(plan).toBe(2) });", // Biome: noFocusedTests; Vitest: fails
  '',
].join('\n');

/** A clean project around it: one passing test, and a script that uses every dependency. */
const clean: readonly ProjectFile[] = [
  {
    placedAt: 'test/unit/clean.test.ts',
    content:
      "import { expect, it } from 'vitest';\n\nit('passes', () => {\n  expect(1).toBe(1);\n});\n",
  },
  {
    placedAt: 'scripts/uses.ts',
    content: [
      "import { Client as FtpClient } from 'basic-ftp';",
      "import { build } from 'esbuild';",
      "import { Client } from 'ssh2';",
      "import { parse } from 'yaml';",
      "import { z } from 'zod';",
      '',
      'console.log(FtpClient, build, Client, parse, z);',
      '',
    ].join('\n'),
  },
];

const badPath = 'test/unit/bad.test.ts';

describe('another worktree in .worktrees/, ignored by every gate', () => {
  let inside: string | undefined;
  let outside: string | undefined;
  const runs = new Map<string, GateRun>();
  const run = (where: string, gate: GateName): GateRun => {
    const found = runs.get(`${where} ${gate}`);
    if (found === undefined) throw new Error(`no run of ${gate} ${where}`);
    return found;
  };

  beforeAll(async () => {
    inside = makeProject([
      ...clean,
      // Its own root config, as a checkout of the repo has: Biome refuses two roots.
      {
        placedAt: '.worktrees/x/biome.json',
        content: readFileSync(join(repoRoot, 'biome.json'), 'utf8'),
      },
      { placedAt: `.worktrees/x/${badPath}`, content: badFile },
    ]);
    outside = makeProject([...clean, { placedAt: badPath, content: badFile }]);
    const projects = { inside, outside };
    await Promise.all(
      Object.entries(projects).flatMap(([where, root]) =>
        gateNames.map(async (gate) => runs.set(`${where} ${gate}`, await runGate(gate, root))),
      ),
    );
  });
  afterAll(() => {
    removeProject(inside);
    removeProject(outside);
  });

  it.each(gateNames)('%s passes with the bad file inside .worktrees/x/', (gate) => {
    const result = run('inside', gate);
    expect(result.exitCode, result.output).toBe(0);
  });

  it.each(gateNames)('%s fails on the same file outside .worktrees/, naming it', (gate) => {
    const result = run('outside', gate);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(badPath);
  });
});
