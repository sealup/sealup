// The package gate: users run exactly the bytes we tested (decision 0011, R24) and installs stay
// strict (decision 0010, R25).
//
//   node scripts/check-package.ts [--root <folder>] [--pack <npm pack --dry-run --json output>]
//
// Rules, each with an id printed on the violation line:
//   no-dependencies     no dependencies, optionalDependencies, peerDependencies, bundleDependencies:
//                       every library is inside the bundle
//   no-install-scripts  no preinstall, install, postinstall or prepare script
//   exact-versions      every devDependency is an exact version (no ^, ~, ranges, tags)
//   allow-scripts       package.json#allowScripts approves esbuild only
//   bin                 `sealup` runs dist/cli.mjs
//   no-private          no `private`: the package is published (spec #41 decision 39)
//   public-fields       repository (the public sealup/sealup), homepage, bugs, keywords and author
//                       are set, so npm's page links back to the public repo
//   npmrc               .npmrc has strict-allow-scripts=true, min-release-age=<days ≥ 1>,
//                       engine-strict=true, save-exact=true
//   pack-files          (with --pack) the packed files are within the allow-list, and the
//                       bundle, both licence files and the schema are there
//
// npm 11.19 maps 0010's "allow-scripts for esbuild only" onto package.json#allowScripts (ruling
// 12); `strict-allow-scripts` turns any other dependency's install script into an error.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];
const installScripts = ['preinstall', 'install', 'postinstall', 'prepare'];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const allowedScriptPackages = ['esbuild'];
const requiredNpmrc: readonly [key: string, ok: (value: string) => boolean, want: string][] = [
  ['strict-allow-scripts', (v) => v === 'true', 'strict-allow-scripts=true'],
  ['min-release-age', (v) => /^\d+$/.test(v) && Number(v) >= 1, 'min-release-age=<days ≥ 1>'],
  ['engine-strict', (v) => v === 'true', 'engine-strict=true'],
  ['save-exact', (v) => v === 'true', 'save-exact=true'],
];
/** Files the npm package may hold; npm adds package.json, README and LICENSE by itself. */
const packAllowed = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli.mjs',
  'dist/THIRD_PARTY_LICENSES.txt',
  // The JSON Schema of sealup.yml, generated from the config module (spec #1, ticket 09).
  'schema.json',
];
const packRequired = [
  'package.json',
  // sealup's own MIT licence (0016): the licence asks for its text in every copy.
  'LICENSE',
  'dist/cli.mjs',
  'dist/THIRD_PARTY_LICENSES.txt',
  'schema.json',
];

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly allowScripts?: Readonly<Record<string, unknown>>;
  readonly bin?: unknown;
  readonly [field: string]: unknown;
}

function packageProblems(pkg: PackageJson): string[] {
  const problems: string[] = [];
  for (const field of dependencyFields) {
    const value = pkg[field];
    const empty =
      value === undefined ||
      (Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0);
    if (!empty) problems.push(`no-dependencies: package.json has ${field}; bundle it instead`);
  }
  for (const name of installScripts) {
    if (pkg.scripts?.[name] !== undefined) {
      problems.push(`no-install-scripts: package.json has a "${name}" script`);
    }
  }
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    if (!exactVersion.test(version)) {
      problems.push(
        `exact-versions: devDependencies.${name} is "${version}", not an exact version`,
      );
    }
  }
  for (const [spec, allowed] of Object.entries(pkg.allowScripts ?? {})) {
    const name = spec.replace(/(?!^)@.*$/, '');
    if (allowed !== false && !allowedScriptPackages.includes(name)) {
      problems.push(`allow-scripts: install scripts allowed for "${spec}"; only esbuild may run`);
    }
  }
  const bin = pkg.bin as Record<string, unknown> | undefined;
  if (typeof bin !== 'object' || bin === null || bin.sealup !== 'dist/cli.mjs') {
    problems.push('bin: package.json#bin.sealup must be "dist/cli.mjs"');
  }
  if (pkg.private !== undefined) {
    problems.push('no-private: package.json has "private"; the package is published');
  }
  for (const [field, ok, want] of publicFields) {
    if (!ok(pkg[field])) problems.push(`public-fields: package.json#${field} must be ${want}`);
  }
  return problems;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const urlOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? (value as { url?: unknown }).url : value;
const httpsUrl = (value: unknown): boolean => text(value) && value.startsWith('https://');
const publicRepo = /^git\+https:\/\/github\.com\/sealup\/sealup\.git$/;
const publicFields: readonly [field: string, ok: (value: unknown) => boolean, want: string][] = [
  [
    'repository',
    (v) => {
      const url = urlOf(v);
      return text(url) && publicRepo.test(url);
    },
    'the public repo, git+https://github.com/sealup/sealup.git',
  ],
  ['homepage', httpsUrl, 'an https URL'],
  ['bugs', (v) => httpsUrl(urlOf(v)), 'an https URL to the issues'],
  [
    'keywords',
    (v) => Array.isArray(v) && v.length > 0 && v.every(text),
    'a list of words, not empty',
  ],
  ['author', (v) => text(v) || text((v as { name?: unknown } | null)?.name), 'a name'],
];

function npmrcProblems(text: string): string[] {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
  }
  return requiredNpmrc
    .filter(([key, ok]) => !ok(values.get(key) ?? ''))
    .map(([, , want]) => `npmrc: ${want} is missing from .npmrc`);
}

function packProblems(packOutput: string): string[] {
  const parsed = JSON.parse(packOutput) as { files?: { path: string }[] }[];
  const files = (parsed[0]?.files ?? []).map((file) => file.path.replaceAll('\\', '/'));
  return [
    ...files
      .filter((file) => !packAllowed.includes(file))
      .map((file) => `pack-files: ${file} is not on the allow-list of packed files`),
    ...packRequired
      .filter((file) => !files.includes(file))
      .map((file) => `pack-files: ${file} is missing (run the build first)`),
  ];
}

const { values } = parseArgs({ options: { root: { type: 'string' }, pack: { type: 'string' } } });
const root = values.root ?? process.cwd();
const problems = [
  ...packageProblems(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson),
  ...npmrcProblems(readFileSync(join(root, '.npmrc'), 'utf8')),
  ...(values.pack === undefined ? [] : packProblems(readFileSync(values.pack, 'utf8'))),
];
for (const problem of problems) console.error(problem);
console.error(
  problems.length === 0 ? 'package: all rules hold' : `package: ${problems.length} problem(s)`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
