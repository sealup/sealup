// The release assets (decision 0017; spec #41 decision 36), from a built project (scripts/build.ts
// first): what the public release attests and attaches to its GitHub release.
// The public release.yml runs it, and so does CI's release dry run on each pull request.
//
//   node scripts/release-assets.ts <out> [--notes <file>] [--root <folder>]
//
// <out>     must not exist yet, or be empty; it receives exactly the release's assets:
//             sealup-<version>.tgz   the npm package (`npm pack`), checked by the package gate
//             action.mjs             the action's bundle, dist/action.mjs
//             SHA256SUMS             both files' SHA-256, as `sha256sum -c` reads it
// --notes   writes the release notes there: this version's CHANGELOG.md section, how to use it
//           (the action by its version tag, 0043), and the verify commands
// --root    the project (default: the repo)
//
// Exit 0 when written, 1 when the package gate or a step fails, 2 on a usage error.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from './gates.ts';

interface Options {
  readonly out: string;
  readonly notes: string | undefined;
  readonly root: string;
}

function options(argv: readonly string[]): Options | string {
  let values: { notes?: string; root?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { notes: { type: 'string' }, root: { type: 'string' } },
    }));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (positionals.length !== 1) return 'give one output folder';
  const out = resolve(positionals[0] ?? '');
  if (existsSync(out) && readdirSync(out).length > 0) return `${out} is not empty`;
  return {
    out,
    notes: values.notes === undefined ? undefined : resolve(values.notes),
    root: resolve(values.root ?? repoRoot),
  };
}

/** This version's section of the public CHANGELOG.md (decision 0042), without its heading. */
function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const v = version.replaceAll('.', '\\.');
  const start = lines.findIndex((line) => new RegExp(`^## \\[?${v}\\]?(?:[ (]|$)`).test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function releaseNotes(version: string, changes: string | undefined): string {
  const tag = `v${version}`;
  const tarball = `sealup-${version}.tgz`;
  return [
    changes ?? 'No changelog entry for this version.',
    '',
    '## Use it',
    '',
    '```sh',
    `npx sealup@${version} init`,
    '```',
    '',
    'In GitHub Actions (`sealup init` writes it for you):',
    '',
    '```yaml',
    `- uses: sealup/sealup@${tag}`,
    '```',
    '',
    'The npm version is staged by this release and appears on npm once the maintainer approves it with 2FA.',
    '',
    '## Verify it',
    '',
    '```sh',
    'sha256sum -c SHA256SUMS                                  # beside the downloaded assets',
    `gh release verify ${tag} --repo sealup/sealup`,
    `gh release verify-asset ${tag} ${tarball} --repo sealup/sealup`,
    `gh attestation verify ${tarball} --repo sealup/sealup`,
    `gh attestation verify ${tarball} --repo sealup/sealup --bundle provenance.sigstore.json`,
    'gh attestation verify action.mjs --repo sealup/sealup',
    'gh attestation verify action.mjs --repo sealup/sealup --bundle provenance.sigstore.json',
    'npm audit signatures                                     # in a project that installed sealup',
    '```',
    '',
  ].join('\n');
}

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/** Use npm's own CLI under npm; direct node calls resolve the npm installed with Node. */
export function npmCliPath(): string {
  const inherited = process.env.npm_execpath;
  if (inherited !== undefined && basename(inherited) === 'npm-cli.js') return inherited;
  const nodeDir = dirname(process.execPath);
  // Windows puts npm in node_modules beside node.exe; Unix puts it in ../lib/node_modules.
  const pkg = createRequire(process.execPath).resolve('npm/package.json', {
    paths: [nodeDir, join(nodeDir, '..', 'lib')],
  });
  return join(dirname(pkg), 'bin', 'npm-cli.js');
}

function assets(o: Options): string {
  const pkg = JSON.parse(readFileSync(join(o.root, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string') throw new Error("package.json's version is missing");
  const version = pkg.version;
  const work = mkdtempSync(join(tmpdir(), 'sealup-release-assets-'));
  try {
    mkdirSync(o.out, { recursive: true });
    const listing = execFileSync(
      process.execPath,
      [npmCliPath(), 'pack', '--json', '--pack-destination', o.out],
      {
        cwd: o.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const listingFile = join(work, 'pack.json');
    writeFileSync(listingFile, listing);
    execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'check-package.ts'), '--root', o.root, '--pack', listingFile],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const tarball = `sealup-${version}.tgz`;
    if (!existsSync(join(o.out, tarball))) throw new Error(`npm pack made no ${tarball}`);
    copyFileSync(join(o.root, 'dist', 'action.mjs'), join(o.out, 'action.mjs'));
    const sums = [tarball, 'action.mjs'].map((name) => `${sha256(join(o.out, name))}  ${name}\n`);
    writeFileSync(join(o.out, 'SHA256SUMS'), sums.join(''));
    if (o.notes !== undefined) {
      const changelog = join(o.root, 'CHANGELOG.md');
      const changes = existsSync(changelog)
        ? changelogSection(readFileSync(changelog, 'utf8'), version)
        : undefined;
      if (changes === undefined) console.error(`note: CHANGELOG.md has no ${version} section`);
      writeFileSync(o.notes, releaseNotes(version, changes));
    }
    return `release assets: ${tarball}, action.mjs and SHA256SUMS in ${o.out}`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const parsed = options(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`release assets: ${parsed}`);
    console.error('usage: node scripts/release-assets.ts <out> [--notes <file>] [--root <folder>]');
    process.exitCode = 2;
  } else {
    try {
      console.error(assets(parsed));
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const why = stderr === undefined || stderr === null ? String(error) : String(stderr);
      console.error(`release assets: stopped, ${why.trim()}`);
      process.exitCode = 1;
    }
  }
}
