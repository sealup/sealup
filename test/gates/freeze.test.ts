// The freeze test (test/integration/goldens/frozen-seams.test.ts), proven to bite. The shape
// snapshot runs the compiler on temp copies of the repo: a changed type in contracts or plan's
// exports fails it, a changed comment does not. The other seams are compared as text, byte for
// byte: a renamed `--json` key, keys in another order, a changed manifest encoding, exit code,
// docs slug or event order each fail their golden, with the seam named and decision 0026's rule.
// The exit codes and the docs slugs are also changed in a temp copy of the source, then loaded
// from it: their golden tests read the source, not a copy of its values. A file added under
// contracts and missing from the shape snapshot's list fails the check that every file is in it.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import {
  docsSlugsText,
  exitCodesText,
  expectContractsInShape,
  expectFrozen,
  expectFrozenJson,
  seamGoldens,
  seamShape,
} from '../freeze-kit.ts';

const never = { update: false } as const;
const golden = (name: string): string => readFileSync(join(seamGoldens, name), 'utf8');

/** `text` with `from` replaced by `to`; fails when `from` is not there, so no edit goes missing. */
function edit(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`the bite test's edit found nothing: ${from}`);
  return text.replace(from, to);
}

/** Edits to files, by repo-relative path. */
type Changes = Readonly<Record<string, (text: string) => string>>;

/** A temp copy of the repo's package.json, tsconfig.json and src/, with `changes` made. */
function copyWith(changes: Changes): string {
  const root = mkdtempSync(join(tmpdir(), 'sealup-freeze-'));
  for (const name of ['package.json', 'tsconfig.json']) {
    cpSync(join(repoRoot, name), join(root, name));
  }
  cpSync(join(repoRoot, 'src'), join(root, 'src'), { recursive: true });
  for (const [file, change] of Object.entries(changes)) {
    const path = join(root, ...file.split('/'));
    writeFileSync(path, change(readFileSync(path, 'utf8')));
  }
  return root;
}

const shapeRule = /Frozen seam changed: the shape of contracts and plan\(\) \(decision 0026\)/;

describe('freeze test, proven to bite: the shape of contracts and plan()', () => {
  type Variant = 'comments' | 'contractsType' | 'contractsEntry' | 'planExport';
  const changes: Record<Variant, Changes> = {
    comments: {
      'src/contracts/index.ts': (text) =>
        edit(
          text,
          '// contracts: the shared types and ports',
          '// contracts: the shared types and ports, a header edited',
        ),
      'src/contracts/run.ts': (text) =>
        edit(text, '/** Done, or nothing to do. */', '/** Done (a comment edited). */'),
      'src/plan/index.ts': (text) =>
        edit(text, 'export function plan(', '/** A doc comment added. */\nexport function plan('),
    },
    contractsType: {
      'src/contracts/config.ts': (text) =>
        edit(
          text,
          "export type AllowedRisk = 'empty-source' | 'symlinks' | 'root-folder';",
          "export type AllowedRisk = 'empty-source' | 'symlinks';",
        ),
    },
    contractsEntry: {
      'src/contracts/index.ts': (text) => edit(text, '  type HostKey,\n', ''),
    },
    planExport: {
      'src/plan/index.ts': (text) =>
        edit(
          text,
          'export function plan(input: PlanInput): Plan {',
          'export function plan(input: PlanInput, _strict?: boolean): Plan {',
        ),
    },
  };
  const roots: string[] = [];
  const shapes: Record<Variant, string> = {
    comments: '',
    contractsType: '',
    contractsEntry: '',
    planExport: '',
  };

  beforeAll(async () => {
    const names = Object.keys(changes) as Variant[];
    roots.push(...names.map((name) => copyWith(changes[name])));
    const made = await Promise.all(roots.map((root) => seamShape(root)));
    names.forEach((name, i) => {
      shapes[name] = made[i] ?? '';
    });
  });
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('passes when only comments changed', () => {
    expectFrozen('the shape of contracts and plan()', shapes.comments, 'shape.golden', never);
  });

  it('fails when a type in contracts changed, naming the seam and the rule', () => {
    expect(() =>
      expectFrozen(
        'the shape of contracts and plan()',
        shapes.contractsType,
        'shape.golden',
        never,
      ),
    ).toThrow(shapeRule);
  });

  it('fails when the contracts entry file stops re-exporting a name', () => {
    expect(() =>
      expectFrozen(
        'the shape of contracts and plan()',
        shapes.contractsEntry,
        'shape.golden',
        never,
      ),
    ).toThrow(shapeRule);
  });

  it("fails when one of plan's exports changed", () => {
    expect(() =>
      expectFrozen('the shape of contracts and plan()', shapes.planExport, 'shape.golden', never),
    ).toThrow(shapeRule);
  });
});

describe('freeze test, proven to bite: every file of contracts in the shape', () => {
  const roots: string[] = [];
  /** A temp copy of the source with `file` (repo-relative) added, holding one exported type. */
  const copyAdding = (file: string): string => {
    const root = copyWith({});
    roots.push(root);
    const path = join(root, ...file.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'export type Added = 1;\n');
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('passes on an unchanged copy', () => {
    const root = copyWith({});
    roots.push(root);
    expectContractsInShape(root);
  });

  it.each(['src/contracts/added.ts', 'src/contracts/more/added.ts'])(
    'fails when %s is missing from shapeFiles, naming it and the rule',
    (file) => {
      const root = copyAdding(file);
      expect(() => expectContractsInShape(root)).toThrow(
        /A file of contracts is missing from the shape snapshot \(decision 0026\)/,
      );
      expect(() => expectContractsInShape(root)).toThrow(file);
    },
  );
});

describe('freeze test, proven to bite: the seams compared as text', () => {
  /** The golden's JSON as `--json` writes it: one line. */
  const oneLine = (name: string): string => `${JSON.stringify(JSON.parse(golden(name)))}\n`;

  it('fails on a renamed --json key', () => {
    const stdout = edit(oneLine('json-success.golden'), '"uploaded":', '"uploads":');
    expect(() => expectFrozenJson('a success', stdout, 'json-success.golden', never)).toThrow(
      /Frozen seam changed: the --json object of a success \(decision 0026\)/,
    );
  });

  it('fails on --json keys in another order', () => {
    const object = JSON.parse(golden('json-failed.golden')) as Record<string, unknown>;
    const { format, ...rest } = object;
    const stdout = `${JSON.stringify({ ...rest, format })}\n`;
    expect(() => expectFrozenJson('a failure', stdout, 'json-failed.golden', never)).toThrow(
      /Frozen seam changed: the --json object of a failure/,
    );
  });

  it('passes on the --json object as written', () => {
    for (const name of ['success', 'dry-run', 'part-way', 'failed', 'reconnected']) {
      const file = `json-${name}.golden`;
      expectFrozenJson(name, oneLine(file), file, never);
    }
  });

  it.each([
    {
      seam: 'manifest format 1',
      file: 'manifest-format-1.golden',
      change: (text: string) => edit(text, '"size":13,"sha256"', '"sha256"'),
    },
    {
      seam: 'manifest format 2',
      file: 'manifest-format-2.golden',
      change: (text: string) => edit(text, ',"pending":[', ',"leftovers":['),
    },
    {
      seam: 'the exit codes',
      file: 'exit-codes.golden',
      change: (text: string) => edit(text, '"safetyNet": 6', '"safetyNet": 7'),
    },
    {
      seam: 'the docs slugs',
      file: 'docs-slugs.golden',
      change: (text: string) => edit(text, 'quota-full\n', 'out-of-space\n'),
    },
    {
      seam: 'the events of a first deploy',
      file: 'first-deploy-events.golden',
      change: (text: string) => edit(text, 'host-key\nplan\n', 'plan\nhost-key\n'),
    },
  ])('fails on a change to $seam', ({ seam, file, change }) => {
    expect(() => expectFrozen(seam, change(golden(file)), file, never)).toThrow(
      `Frozen seam changed: ${seam} (decision 0026)`,
    );
  });
});

describe('freeze test, proven to bite: exit codes and docs slugs, changed in the source', () => {
  type Contracts = typeof import('../../src/contracts/index.ts');
  type Report = typeof import('../../src/report/index.ts');
  /** For each seam: its golden, the source edit, and what the golden test compares. */
  const seams = [
    {
      seam: 'the exit codes',
      golden: 'exit-codes.golden',
      file: 'src/contracts/run.ts',
      change: (text: string) => edit(text, 'safetyNet: 6,', 'safetyNet: 7,'),
      read: async (root: string) =>
        exitCodesText((await load<Contracts>(root, 'src/contracts/index.ts')).ExitCode),
    },
    {
      seam: 'the docs slugs',
      golden: 'docs-slugs.golden',
      file: 'src/report/problems.ts',
      change: (text: string) => edit(text, "  'quota-full',\n", "  'out-of-space',\n"),
      read: async (root: string) =>
        docsSlugsText((await load<Report>(root, 'src/report/index.ts')).docsSlugs),
    },
  ] as const;
  const roots: string[] = [];
  const copy = (changes: Changes): string => {
    const root = copyWith(changes);
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it.each(seams)(
    '$seam: an unchanged copy passes, a changed one fails',
    async ({ seam, golden, file, change, read }) => {
      expectFrozen(seam, await read(copy({})), golden, never);
      const changed = await read(copy({ [file]: change }));
      expect(() => expectFrozen(seam, changed, golden, never)).toThrow(
        `Frozen seam changed: ${seam} (decision 0026)`,
      );
    },
  );
});

/** A module of the source copy under `root`, loaded the way the tests load the repo's own. */
function load<T>(root: string, file: string): Promise<T> {
  return import(pathToFileURL(join(root, ...file.split('/'))).href) as Promise<T>;
}
