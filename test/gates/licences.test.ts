// The licence gate (decision 0016), proven to bite: a fixture project whose metafile bundles
// packages with good and bad licences, checked by the real script.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { checkLicences } from '../../scripts/licences.ts';
import { type GateRun, runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'licences.ts');

interface FixturePackage {
  readonly folder: string;
  readonly manifest: Record<string, unknown>;
  readonly licenceFile?: string;
}

const good: readonly FixturePackage[] = [
  { folder: 'node_modules/plain-mit', manifest: { license: 'MIT' }, licenceFile: 'LICENSE' },
  // ssh2 1.17 has only the legacy field.
  {
    folder: 'node_modules/legacy-field',
    manifest: { licenses: [{ type: 'MIT' }] },
    licenceFile: 'LICENSE.md',
  },
  {
    folder: 'node_modules/@scope/either',
    manifest: { license: '(MIT OR GPL-3.0)' },
    licenceFile: 'LICENCE',
  },
  {
    folder: 'node_modules/plain-mit/node_modules/nested-isc',
    manifest: { license: 'ISC' },
    licenceFile: 'license',
  },
];

const bad: readonly (FixturePackage & { readonly bites: string })[] = [
  {
    bites: 'a licence outside the allow-list',
    folder: 'node_modules/copyleft',
    manifest: { license: 'GPL-3.0-only' },
    licenceFile: 'LICENSE',
  },
  {
    bites: 'an AND with one part outside the allow-list',
    folder: 'node_modules/both-needed',
    manifest: { license: 'MIT AND SSPL-1.0' },
    licenceFile: 'LICENSE',
  },
  {
    bites: 'no licence at all',
    folder: 'node_modules/no-licence',
    manifest: {},
    licenceFile: 'LICENSE',
  },
  {
    bites: 'no licence file to copy',
    folder: 'node_modules/no-file',
    manifest: { license: 'MIT' },
  },
];

function makeFixture(packages: readonly FixturePackage[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sealup-licences-'));
  const inputs: Record<string, unknown> = { 'src/cli/bin.ts': {} };
  for (const pkg of packages) {
    const dir = join(root, ...pkg.folder.split('/'));
    mkdirSync(dir, { recursive: true });
    const name = pkg.folder.split('node_modules/').at(-1);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...pkg.manifest }),
    );
    if (pkg.licenceFile !== undefined) {
      writeFileSync(join(dir, pkg.licenceFile), `Licence text of ${name}\n`);
    }
    inputs[`${pkg.folder}/lib/index.js`] = {};
  }
  writeFileSync(join(root, 'meta.json'), JSON.stringify({ inputs }));
  return root;
}

describe('licences, proven to bite', () => {
  let root = '';
  let run: GateRun = { exitCode: 0, output: '' };

  beforeAll(async () => {
    root = makeFixture([...good, ...bad]);
    run = await runNode([script, join(root, 'meta.json'), '--root', root], root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('fails', () => {
    expect(run.exitCode).toBe(1);
  });

  it.each(bad)('names $folder: $bites', (pkg) => {
    const name = pkg.folder.split('node_modules/').at(-1) ?? '';
    expect(run.output).toContain(`${name}@1.0.0:`);
  });

  it.each(good)('accepts $folder', (pkg) => {
    const name = pkg.folder.split('node_modules/').at(-1) ?? '';
    expect(run.output).not.toContain(`${name}@1.0.0:`);
  });
});

describe('licences, on allowed packages', () => {
  let root = '';
  beforeAll(() => {
    root = makeFixture(good);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('passes and copies each licence text under its package name', () => {
    const report = checkLicences(
      { inputs: { 'node_modules/plain-mit/a.js': {}, 'node_modules/@scope/either/b.js': {} } },
      root,
    );
    expect(report.problems).toEqual([]);
    expect(report.text).toContain('plain-mit@1.0.0 (MIT)\n\nLicence text of plain-mit');
    expect(report.text).toContain(
      '@scope/either@1.0.0 ((MIT OR GPL-3.0))\n\nLicence text of @scope/either',
    );
  });

  it('says so when nothing third-party is bundled', () => {
    const report = checkLicences({ inputs: { 'src/cli/bin.ts': {} } }, root);
    expect(report.problems).toEqual([]);
    expect(report.text).toBe('sealup bundles no third-party code.\n');
  });
});
