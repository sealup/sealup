import { describe, expect, it } from 'vitest';
import { makeProject, provenToBite, removeProject, runGate } from './gate-kit.ts';

provenToBite('imports', 'imports');

describe('import rules, allowed imports', () => {
  it('pass: entry files on the list, files inside the own module, comments, Node in non-pure modules', async () => {
    const file = (placedAt: string, content: string) => ({ placedAt, content });
    const project = makeProject([
      file('src/contracts/index.ts', 'export type Sha256 = string;\n'),
      file(
        'src/paths/index.ts',
        "import type { Sha256 } from '../contracts/index.ts';\nexport type P = Sha256;\n",
      ),
      file(
        'src/plan/index.ts',
        [
          "import type { P } from '../paths/index.ts';",
          "import { rule } from './rules.ts';",
          "// import { connect } from '../transport/index.ts';",
          "/* import 'node:fs'; */",
          'export const x: P = rule;',
          '',
        ].join('\n'),
      ),
      file('src/plan/rules.ts', "export const rule = `import 'node:fs'`;\n"),
      file(
        'src/scan/index.ts',
        "import { readdir } from 'node:fs/promises';\nexport const r = readdir;\n",
      ),
      file('src/config/index.ts', "import { parse } from 'yaml';\nexport const p = parse;\n"),
      file(
        'src/transport/index.ts',
        "import { reveal } from '../secret/index.ts';\nexport const r = reveal;\n",
      ),
      file(
        'src/report/index.ts',
        "import { redact } from '../secret/index.ts';\nexport const r = redact;\n",
      ),
      file('src/secret/index.ts', 'export const reveal = 1;\nexport const redact = 2;\n'),
      file(
        'test/unit/plan.test.ts',
        "import { x } from '../../src/plan/index.ts';\nexport const y = x;\n",
      ),
      file(
        'scripts/tool.ts',
        "import { spawn } from 'node:child_process';\nexport const s = spawn;\n",
      ),
    ]);
    try {
      const run = await runGate('imports', project);
      expect(run.output).toContain('all imports allowed');
      expect(run.exitCode).toBe(0);
    } finally {
      removeProject(project);
    }
  });
});

describe('source rules', () => {
  const file = (placedAt: string, content: string) => ({ placedAt, content });
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, i) => `export const l${i} = ${i};\n`).join('');

  it('pass: casts inside paths, ExitCode names, cast words in strings, type arguments, 800 lines', async () => {
    const project = makeProject([
      file('src/contracts/index.ts', 'export type RemotePath = string;\n'),
      file(
        'src/paths/index.ts',
        "import type { RemotePath } from '../contracts/index.ts';\nexport const p = 'a' as RemotePath;\n",
      ),
      file(
        'src/plan/index.ts',
        [
          "import type { RemotePath } from '../contracts/index.ts';",
          "export const note = 'never write x as ServerPath';",
          'export const seen = new Set<RemotePath>();',
          'export const exitCode = ExitCode.ok;',
          '',
        ].join('\n'),
      ),
      file('scripts/long.ts', lines(800)),
    ]);
    try {
      const run = await runGate('imports', project);
      expect(run.output).toContain('all source rules hold');
      expect(run.exitCode).toBe(0);
    } finally {
      removeProject(project);
    }
  });

  it('bites: a file of 801 lines', async () => {
    const project = makeProject([file('scripts/long.ts', lines(801))]);
    try {
      const run = await runGate('imports', project);
      expect(run.output).toContain('scripts/long.ts:801 file-too-long: 801 lines');
      expect(run.exitCode).toBe(1);
    } finally {
      removeProject(project);
    }
  });
});
