// action.yml (0014, spec #24 decision 33): a Node 24 action running the committed bundle, and no
// `@actions/*` package anywhere. Its inputs and outputs against the CLI page are checked in
// test/private/action-yml-page.test.ts (the page stays private).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../../scripts/gates.ts';

interface ActionYml {
  readonly runs: Record<string, unknown>;
  readonly branding?: unknown;
}

const action = parse(readFileSync(join(repoRoot, 'action.yml'), 'utf8')) as ActionYml;

describe('action.yml', () => {
  it('runs the committed bundle on Node 24, in the same process', () => {
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/action.mjs' });
  });

  it("has the Marketplace's branding: the seal's arrow, in the wax's green (spec #41 decision 39)", () => {
    // GitHub takes one of its listed Feather icons and one of eight colours; brand.md's wax green
    // is the nearest, and the seal's arrow rising inside it the nearest icon.
    expect(action.branding).toEqual({ icon: 'arrow-up-circle', color: 'green' });
  });

  it('uses no @actions/* package: none installed, none bundled', () => {
    const lock = readFileSync(join(repoRoot, 'package-lock.json'), 'utf8');
    expect(lock).not.toContain('node_modules/@actions/');
    const bundle = readFileSync(join(repoRoot, 'dist', 'action.mjs'), 'utf8');
    expect(bundle).not.toContain('@actions/');
  });
});
