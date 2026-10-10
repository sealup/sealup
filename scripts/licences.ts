// The licence gate (decision 0016): every package inside the bundle has a licence on the
// allow-list, and its licence text goes into THIRD_PARTY_LICENSES.txt.
//
//   node scripts/licences.ts <metafile> [--root <folder>]   prints the problems, exit 1 if any
//
// The packages come from the esbuild metafile (what is really bundled), not from node_modules:
// a dev tool never reaches users, a bundled library always does. esbuild's legal comments do not
// cover this (ssh2's dependencies carry none). The licence is `license` in the package's
// package.json, or the legacy `licenses: [{ type }]` (ssh2 1.17 has only that). An SPDX `OR`
// passes when one side is allowed, `AND` when every part is; anything with brackets inside
// needs a human. A package without a licence file fails: MIT and BSD require the notice.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** Decision 0016. */
const allowedLicences: readonly string[] = [
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'Unlicense',
  '0BSD',
];

interface Metafile {
  readonly inputs: Readonly<Record<string, unknown>>;
}

interface BundledPackage {
  readonly name: string;
  readonly version: string;
  readonly licence: string | undefined;
  readonly licenceText: string | undefined;
}

interface LicenceReport {
  readonly problems: readonly string[];
  /** The content of THIRD_PARTY_LICENSES.txt. */
  readonly text: string;
}

/** The package folders (relative, `/`) of the bundled inputs that come from node_modules. */
function packageFolders(metafile: Metafile): string[] {
  const folders = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const path = input.replaceAll('\\', '/');
    const matches = [...path.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\//g)];
    const last = matches.at(-1);
    if (last !== undefined) folders.add(path.slice(0, last.index + last[0].length - 1));
  }
  return [...folders].sort();
}

function readPackage(root: string, folder: string): BundledPackage {
  // Inputs are relative to the build's working folder, or absolute on another drive.
  const dir = resolve(root, folder);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    license?: unknown;
    licenses?: unknown;
  };
  let licence = typeof manifest.license === 'string' ? manifest.license : undefined;
  if (licence === undefined && Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'type' in entry ? entry.type : undefined,
      )
      .filter((type): type is string => typeof type === 'string');
    if (types.length > 0) licence = types.join(' OR ');
  }
  const licenceFile = readdirSync(dir)
    .sort()
    .find((name) => /^(?:licen[cs]e|copying)(?:[.-].*)?$/i.test(name));
  return {
    name: manifest.name ?? folder.split('node_modules/').at(-1) ?? folder,
    version: manifest.version ?? '?',
    licence,
    licenceText:
      licenceFile === undefined ? undefined : readFileSync(join(dir, licenceFile), 'utf8'),
  };
}

/** True when the SPDX expression is allowed (see the header for the rule). */
function isAllowed(expression: string): boolean {
  const bare = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (/[()]/.test(bare)) return false;
  return bare
    .split(/\s+OR\s+/)
    .some((side) => side.split(/\s+AND\s+/).every((id) => allowedLicences.includes(id.trim())));
}

/** Checks the bundled packages of a metafile whose input paths are relative to `root`. */
export function checkLicences(metafile: Metafile, root: string): LicenceReport {
  const packages = packageFolders(metafile).map((folder) => readPackage(root, folder));
  const problems: string[] = [];
  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    if (pkg.licence === undefined) problems.push(`${id}: no licence in its package.json`);
    else if (!isAllowed(pkg.licence))
      problems.push(`${id}: licence "${pkg.licence}" is not on the allow-list (decision 0016)`);
    if (pkg.licenceText === undefined) problems.push(`${id}: no licence file to copy`);
  }
  const sections = packages.map((pkg) =>
    [`${pkg.name}@${pkg.version} (${pkg.licence ?? 'unknown'})`, '', pkg.licenceText?.trim()].join(
      '\n',
    ),
  );
  const intro =
    packages.length === 0
      ? 'sealup bundles no third-party code.'
      : 'sealup bundles the following third-party code. Each licence text follows its name.';
  return { problems, text: `${[intro, ...sections].join(`\n\n${'-'.repeat(72)}\n\n`)}\n` };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string' } },
  });
  const [file] = positionals;
  if (file === undefined) {
    console.error('usage: node scripts/licences.ts <metafile> [--root <folder>]');
    process.exitCode = 2;
  } else {
    const metafile = JSON.parse(readFileSync(file, 'utf8')) as Metafile;
    const report = checkLicences(metafile, values.root ?? process.cwd());
    for (const problem of report.problems) console.error(problem);
    console.error(
      report.problems.length === 0
        ? 'licences: all bundled packages allowed'
        : `licences: ${report.problems.length} problem(s)`,
    );
    process.exitCode = report.problems.length === 0 ? 0 : 1;
  }
}
