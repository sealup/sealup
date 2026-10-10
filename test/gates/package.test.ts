// The package gate (decisions 0010, 0011; R24, R25; spec #41 decision 39), proven to bite: the
// repo's package.json and .npmrc pass; copies with one rule broken each fail, naming the rule.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'check-package.ts');

type PackageJson = Record<string, unknown> & { scripts: Record<string, string> };

const realPackage = (): PackageJson =>
  JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
const realNpmrc = (): string => readFileSync(join(repoRoot, '.npmrc'), 'utf8');

/** What `npm pack --dry-run --json` prints, for the given file list. */
const packJson = (files: readonly string[]): string =>
  JSON.stringify([{ name: 'sealup', files: files.map((path) => ({ path, size: 1, mode: 420 })) }]);

const shippedFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli.mjs',
  'dist/THIRD_PARTY_LICENSES.txt',
  'schema.json',
];

/** The shipped files without one of them. */
const shippedWithout = (file: string): string[] => shippedFiles.filter((f) => f !== file);

interface Fixture {
  readonly name: string;
  readonly expect: string;
  readonly pkg?: (pkg: PackageJson) => void;
  readonly npmrc?: (npmrc: string) => string;
  readonly pack?: readonly string[];
}

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

async function check(fixture: Omit<Fixture, 'name' | 'expect'>) {
  const folder = mkdtempSync(join(tmpdir(), 'sealup-package-'));
  folders.push(folder);
  const pkg = realPackage();
  fixture.pkg?.(pkg);
  writeFileSync(join(folder, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(folder, '.npmrc'), fixture.npmrc?.(realNpmrc()) ?? realNpmrc());
  const args = [script, '--root', folder];
  if (fixture.pack !== undefined) {
    writeFileSync(join(folder, 'pack.json'), packJson(fixture.pack));
    args.push('--pack', join(folder, 'pack.json'));
  }
  return runNode(args, folder);
}

const bad: readonly Fixture[] = [
  {
    name: 'a runtime dependency',
    expect: 'no-dependencies',
    pkg: (p) => {
      p.dependencies = { ssh2: '1.17.0' };
    },
  },
  {
    name: 'an optional dependency',
    expect: 'no-dependencies',
    pkg: (p) => {
      p.optionalDependencies = { 'cpu-features': '0.0.10' };
    },
  },
  {
    name: 'a postinstall script',
    expect: 'no-install-scripts',
    pkg: (p) => {
      p.scripts.postinstall = 'node setup.js';
    },
  },
  {
    name: 'a prepare script',
    expect: 'no-install-scripts',
    pkg: (p) => {
      p.scripts.prepare = 'npm run build';
    },
  },
  {
    name: 'a version range',
    expect: 'exact-versions',
    pkg: (p) => {
      (p.devDependencies as Record<string, string>).vitest = '^5.0.3';
    },
  },
  {
    name: 'install scripts allowed for another package',
    expect: 'allow-scripts',
    pkg: (p) => {
      p.allowScripts = { 'esbuild@0.28.2': true, 'ssh2@1.17.0': true };
    },
  },
  {
    name: 'a bin other than dist/cli.mjs',
    expect: 'bin',
    pkg: (p) => {
      p.bin = { sealup: 'src/cli/bin.ts' };
    },
  },
  {
    name: 'a private package (spec #41 decision 39)',
    expect: 'no-private',
    pkg: (p) => {
      p.private = true;
    },
  },
  {
    name: 'a package without a repository',
    expect: 'public-fields: package.json#repository',
    pkg: (p) => {
      delete p.repository;
    },
  },
  {
    name: 'a repository other than the public one',
    expect: 'public-fields: package.json#repository',
    pkg: (p) => {
      p.repository = { type: 'git', url: 'git+https://github.com/sealup/sealup-private.git' };
    },
  },
  {
    name: 'a package without a homepage',
    expect: 'public-fields: package.json#homepage',
    pkg: (p) => {
      delete p.homepage;
    },
  },
  {
    name: 'a package without an issues link',
    expect: 'public-fields: package.json#bugs',
    pkg: (p) => {
      delete p.bugs;
    },
  },
  {
    name: 'a package without keywords',
    expect: 'public-fields: package.json#keywords',
    pkg: (p) => {
      p.keywords = [];
    },
  },
  {
    name: 'a package without an author',
    expect: 'public-fields: package.json#author',
    pkg: (p) => {
      delete p.author;
    },
  },
  {
    name: 'an .npmrc without strict-allow-scripts',
    expect: 'npmrc: strict-allow-scripts=true',
    npmrc: (text) => text.replace(/^strict-allow-scripts=true$/m, ''),
  },
  {
    name: 'an .npmrc without min-release-age',
    expect: 'npmrc: min-release-age',
    npmrc: (text) => text.replace(/^min-release-age=.*$/m, ''),
  },
  {
    name: 'an .npmrc without engine-strict',
    expect: 'npmrc: engine-strict=true',
    npmrc: (text) => text.replace(/^engine-strict=true$/m, 'engine-strict=false'),
  },
  {
    name: 'an .npmrc without save-exact',
    expect: 'npmrc: save-exact=true',
    npmrc: (text) => text.replace(/^save-exact=true$/m, ''),
  },
  {
    name: 'a packed file outside the allow-list',
    expect: 'pack-files: src/cli/index.ts',
    pack: [...shippedFiles, 'src/cli/index.ts'],
  },
  {
    name: 'a pack without the third-party licence file',
    expect: 'pack-files: dist/THIRD_PARTY_LICENSES.txt is missing',
    pack: shippedWithout('dist/THIRD_PARTY_LICENSES.txt'),
  },
  {
    name: "a pack without sealup's own LICENSE (0016)",
    expect: 'pack-files: LICENSE is missing',
    pack: shippedWithout('LICENSE'),
  },
  {
    name: 'a pack without the config schema',
    expect: 'pack-files: schema.json is missing',
    pack: shippedWithout('schema.json'),
  },
];

describe.concurrent('package, proven to bite', () => {
  it.each(bad)('fails on $name', async (fixture) => {
    const run = await check(fixture);
    expect(run.exitCode, run.output).toBe(1);
    expect(run.output).toContain(fixture.expect);
  });
});

describe.concurrent('package, on the repo', () => {
  it("passes the repo's package.json and .npmrc", async () => {
    const run = await runNode([script], repoRoot);
    expect(run.exitCode, run.output).toBe(0);
  });

  it('passes the allowed pack file list', async () => {
    const run = await check({ pack: shippedFiles });
    expect(run.exitCode, run.output).toBe(0);
  });
});
