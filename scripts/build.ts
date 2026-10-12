// Builds the one file the npm package ships (decisions 0010, 0011): `dist/cli.mjs`, ESM, minified,
// every library inside, plus `dist/THIRD_PARTY_LICENSES.txt` and the esbuild metafile. The same
// build makes the GitHub action's bundle, `dist/action.mjs` (0014, spec #24 decision 35): it is
// committed, so it ends with its bundled code's licences in a comment. Each bundle's bytes depend
// on the sources only, never on the output folder (check-dist compares them). It also
// writes `schema.json` at the package root from the config schema (decision 0012; scripts/schema.ts).
//
//   node scripts/build.ts [--outdir <folder>]   default: dist/
//
// No bundle carries sealup's version: each reads it at start-up from the package.json beside it
// (spec #41 decision 34), so a release PR that bumps it changes no committed bundle. Nor does
// any carry the release commit: init's workflow names sealup's step by its version tag (0043).
//
// The CLI bundle's first line is `#!/usr/bin/env node`, before the shims: it is the package's
// `bin`, and npm's shims run the file itself. Without that line the shell reads it on Linux and
// macOS ("import: command not found"), and on Windows sealup.cmd hands it to whatever program
// opens .mjs files, not Node (0.1.0 shipped so; fix-cli-shebang). The action's bundle has none:
// the runner starts it with `node`, and it is committed, byte for byte.
//
// The bundle is ESM, but ssh2 is CommonJS: the banner gives it `require`, `__filename` and
// `__dirname` (without them it dies at start: "Dynamic require of "crypto" is not supported",
// "__dirname is not defined"). ssh2's native parts are left out: `cpu-features` is external
// (esbuild cannot resolve its `.node` file) and both are loaded by ssh2 inside try/catch, so ssh2
// runs in pure JavaScript. The build fails when a bundled licence is outside the allow-list.

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { repoRoot } from './gates.ts';
import { checkLicences } from './licences.ts';
import { writeSchema } from './schema.ts';

const shims = [
  "import { createRequire as __sealupCreateRequire } from 'node:module';",
  "import { fileURLToPath as __sealupFileURLToPath } from 'node:url';",
  "import { dirname as __sealupDirname } from 'node:path';",
  'const require = __sealupCreateRequire(import.meta.url);',
  'const __filename = __sealupFileURLToPath(import.meta.url);',
  'const __dirname = __sealupDirname(__filename);',
].join('\n');

/** The CLI bundle's first line: npm's bin shims run the file, so it names its interpreter. */
const shebang = '#!/usr/bin/env node';

export interface BuildOptions {
  /** Output folder; `dist/` in the repo by default. */
  readonly outdir?: string;
  /** Entry file; `src/cli/bin.ts` by default (tests bundle fixtures through the same build). */
  readonly entry?: string;
}

/**
 * Builds the CLI bundle and its licence file, and (unless `entry` names a fixture) the action's
 * bundle; throws when a build or a licence check fails.
 */
export async function build(options: BuildOptions = {}): Promise<void> {
  const outdir = resolve(options.outdir ?? join(repoRoot, 'dist'));
  mkdirSync(outdir, { recursive: true });
  const cli = await bundle(options.entry ?? join(repoRoot, 'src', 'cli', 'bin.ts'), {
    banner: `${shebang}\n${shims}`,
  });
  writeFileSync(join(outdir, 'cli.mjs'), cli.code);
  writeFileSync(join(outdir, 'meta.json'), JSON.stringify(cli.metafile));
  writeFileSync(join(outdir, 'THIRD_PARTY_LICENSES.txt'), cli.licences);
  if (options.entry === undefined) {
    // The action's bundle is committed alone (spec #24 decision 35), so it carries its bundled
    // code's licences itself, in a comment at its end.
    const action = await bundle(join(repoRoot, 'src', 'action', 'bin.ts'), { banner: shims });
    const notice = action.licences.replaceAll('*/', '* /');
    writeFileSync(join(outdir, 'action.mjs'), `${action.code}\n/*\n${notice}*/\n`);
  }
  writeSchema();
}

/**
 * Spike 05's two savings (spec #41 decision 19, decision 0028's budget), no feature lost:
 *   - `ssh2` resolves to its client alone: its index.js also requires the server, keygen and the
 *     HTTP agents, which CommonJS cannot tree-shake. sealup takes `Client` and `utils.parseKey`
 *     from it, nothing else (transport). Internal ssh2 paths: re-check them on each ssh2 upgrade.
 *   - `yaml` resolves to its ESM build (the package's own `default` export, the same code), so
 *     esbuild drops what config does not use.
 * Each library still reaches the bundle through its own files, so the licence check sees it.
 */
const savings: esbuild.Plugin = {
  name: 'sealup-savings',
  setup(build) {
    build.onResolve({ filter: /^ssh2$/ }, () => ({ path: 'ssh2', namespace: 'sealup-ssh2' }));
    build.onLoad({ filter: /.*/, namespace: 'sealup-ssh2' }, () => ({
      contents: [
        "const { parseKey } = require('ssh2/lib/protocol/keyParser.js');",
        "module.exports = { Client: require('ssh2/lib/client.js'), utils: { parseKey } };",
      ].join('\n'),
      resolveDir: repoRoot,
      loader: 'js',
    }));
    // Its real path, as esbuild gives every other file: a linked node_modules (tests build in a
    // copy of the repo) must not change the bundle's bytes.
    build.onResolve({ filter: /^yaml$/ }, () => ({
      path: realpathSync(join(repoRoot, 'node_modules', 'yaml', 'browser', 'index.js')),
    }));
  },
};

/**
 * One bundle of `entry`, its `banner` first (the shims, after the CLI's shebang), its metafile
 * and its licence text; throws on a licence problem.
 */
async function bundle(
  entry: string,
  options: { readonly banner: string },
): Promise<{ code: string; metafile: esbuild.Metafile; licences: string }> {
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: 'bundle.mjs',
    write: false,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['cpu-features'],
    banner: { js: options.banner },
    plugins: [savings],
    metafile: true,
    logLevel: 'silent',
  });
  const licences = checkLicences(result.metafile, repoRoot);
  if (licences.problems.length > 0) {
    throw new Error(`licence check failed:\n${licences.problems.join('\n')}`);
  }
  const [file] = result.outputFiles;
  if (file === undefined) throw new Error(`esbuild gave no output for ${entry}`);
  return { code: file.text, metafile: result.metafile, licences: licences.text };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { outdir: { type: 'string' } } });
  try {
    await build(values.outdir === undefined ? {} : { outdir: values.outdir });
    const outdir = values.outdir ?? 'dist';
    console.log(`built ${outdir}/cli.mjs and ${outdir}/action.mjs`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
