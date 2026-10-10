// Import rules and source rules, checked on every file in one pass (the `imports` gate).
//
// Import rules: the allowed-import list of the module map (decision 0009). Source rules: the
// mechanical findings of the skeleton's code review, kept here so one file walk serves both.
//
// Run: `node scripts/import-rules.ts` in the repo root. Exit 0 when every file follows every
// rule, 1 with one line per violation otherwise. Type-only imports count: a module that may not
// import another may not know its types either.
//
// Rules, each with an id printed on the violation line:
//   outside-module       every file under src/ belongs to a module folder
//   unknown-module       src/<name>/ must be a module of the map below
//   missing-entry        every module folder has its entry file, index.ts
//   entry-only           code outside a module imports only its entry file (tests included)
//   not-allowed          a module imports only the modules on its list
//   outside-src          product code imports nothing outside src/
//   no-spikes            nothing imports spike code (AGENTS.md)
//   no-child-process     no child processes anywhere in src/ (R5, decision 0019)
//   pure-no-node         pure modules and files import no Node built-in (decision 0009)
//   package-not-allowed  a module imports only the npm packages on its list
//   computed-import      import() and require() in src/ take a plain string
//   reveal-only-transport  only transport imports reveal() from secret (no `* as` import either);
//                        testkit's memory server too (dev only), for files written from a secret
//   forms-only-report    only report imports secretForms() from secret: GitHub's mask lines,
//                        the one place a secret is written (R2)
//
// Source rules, read on the code with comments and the text of strings blanked (the `${…}` of
// template literals kept, since it is code):
//   brand-cast           only paths casts to RemotePath or ServerPath in src/, by `as` or `<…>`
//                        (paths checks what it makes, R10)
//   exit-code-literal    src/ writes no bare number as an exit code: `exitCode =`, `exitCode:`,
//                        `ExitCode =`, `process.exit(…)`; a bare `return 6` is the reviewer's
//   file-too-long        a code file holds at most 800 lines (agents read whole files)
//
// Changing the map below is changing decision 0009's list: do it in the open, in its own commit.

import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix, relative, sep } from 'node:path';

interface ModuleRule {
  /** Modules whose entry file this module may import. */
  readonly imports: readonly string[];
  /** npm packages this module may import. */
  readonly packages?: readonly string[];
  /** A pure module imports no Node built-in. */
  readonly pure?: boolean;
}

const modules: Readonly<Record<string, ModuleRule>> = {
  contracts: { imports: [], pure: true },
  paths: { imports: ['contracts'], pure: true },
  secret: { imports: ['contracts'] },
  config: { imports: ['contracts', 'paths', 'secret'], packages: ['yaml', 'zod'] },
  scan: { imports: ['contracts', 'paths'] },
  manifest: { imports: ['contracts', 'paths'] },
  plan: { imports: ['contracts', 'paths'], pure: true },
  transport: { imports: ['contracts', 'paths', 'secret'], packages: ['ssh2', 'basic-ftp'] },
  // ManifestStore lives in manifest (ruling 6); execute writes through one.
  execute: { imports: ['contracts', 'paths', 'manifest'] },
  report: { imports: ['contracts', 'secret'] },
  deploy: {
    imports: [
      'contracts',
      'paths',
      'secret',
      'config',
      'scan',
      'manifest',
      'plan',
      'transport',
      'execute',
      'report',
    ],
  },
  // `sealup check` runs deploy's steps before connecting, alone (spec #24 decision 14).
  check: { imports: ['contracts', 'config', 'scan', 'deploy'] },
  // `sealup keyscan` reads a target's server from config and scans it through the port it is
  // given; config saves the key (spec #24 decisions 18 and 26).
  keyscan: { imports: ['contracts', 'config'] },
  // `sealup pull` is a use case beside deploy (spec #24 decision 26): deploy's target choice and
  // exit codes, the same ports; it writes on the local disk, inside the config's folder (R19).
  // Its downloads run in execute's pool (0026 point 8: one copy).
  pull: { imports: ['contracts', 'paths', 'config', 'deploy', 'execute'] },
  // `sealup init` writes the project's files (spec #24 decision 26); config owns sealup.yml's
  // text and the env file's form. The sam-sync conversion (#37) reads rsync's excludes with
  // paths' .gitignore matcher.
  init: { imports: ['contracts', 'paths', 'config'] },
  // cli wires the real adapters (spec #1, ruling 6): it passes transport's `connect` to deploy
  // and pull, and transport's `scanHostKey` to keyscan and init. A folder typed at init's
  // question is read by paths' rule (R10).
  cli: {
    imports: [
      'contracts',
      'paths',
      'deploy',
      'check',
      'keyscan',
      'pull',
      'init',
      'config',
      'report',
      'transport',
    ],
  },
  // The GitHub action calls cli's main() in the same process (0014, spec #24 decision 33); its
  // bin wires the real transport, as cli's does. Its own warnings (outputs, plan file) go through
  // report, the one output sink (R1); whether `working-directory` stays in the workspace is
  // paths' rule (R10).
  action: { imports: ['contracts', 'paths', 'config', 'cli', 'report', 'transport'] },
  // Dev only: no product module lists testkit.
  testkit: { imports: ['contracts', 'paths', 'secret'], packages: ['ssh2', 'vitest'] },
};

/**
 * The only modules that may call secret's reveal() (spec #1); secret defines it. testkit (dev
 * only, never bundled) too: its memory server writes a file from a secret as transport does (R17).
 */
const revealers: readonly string[] = ['transport', 'secret', 'testkit'];
/** The only module that may call secret's secretForms() (spec #24 decision 30). */
const maskers: readonly string[] = ['report', 'secret'];

/** Pure files inside modules that are not pure as a whole: the manifest codec, the formatters. */
const pureFiles: readonly string[] = [
  'src/manifest/codec.ts',
  'src/report/format.ts',
  'src/report/problems.ts',
  'src/report/usage-words.ts',
  'src/report/stopped-words.ts',
  'src/report/login-words.ts',
  'src/report/listing-words.ts',
  'src/report/key-words.ts',
  'src/report/warning-words.ts',
  'src/report/config-words.ts',
  'src/report/log.ts',
  'src/report/annotations.ts',
  'src/report/help.ts',
  'src/report/check.ts',
  'src/report/summary.ts',
  'src/report/summary-words.ts',
  'src/report/prompt.ts',
  'src/report/server-words.ts',
  'src/report/pull-words.ts',
  'src/report/lock-words.ts',
  'src/report/tls-words.ts',
  'src/report/reconnect-words.ts',
  'src/report/pull.ts',
  'src/report/keyscan.ts',
  'src/report/certificate-scan.ts',
  'src/report/init.ts',
  'src/init/sam-sync.ts',
];

/** Folders scanned from the root; everything else (docs, spikes, tools) holds no product code. */
const scannedFolders: readonly string[] = ['src', 'test', 'scripts'];
/** Never scanned: the proven-to-bite tests' bad files break these rules on purpose. */
const skippedFolders: readonly string[] = ['test/gates/bad', 'node_modules'];
const codeFile = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const maxLines = 800;
/** `x as ServerPath`, or `<ServerPath>x` (a type argument such as `Set<RemotePath>` follows a name). */
const brandCast = /\bas\s+(?:RemotePath|ServerPath)\b|(?<![\w$])<(?:RemotePath|ServerPath)>/g;
const exitCodeLiteral = /\b(?:exitCode\s*[:=]|ExitCode\s*=|process\.exit\s*\()\s*-?\d/g;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

interface ImportRef {
  /** The string in quotes, or undefined when the specifier is computed. */
  readonly specifier: string | undefined;
  readonly line: number;
  /** What a static import or re-export names (`{ a, b }`, `* as x`); empty for other forms. */
  readonly names: string;
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (folder: string): void => {
    const rel = relative(root, folder).split(sep).join('/');
    if (skippedFolders.includes(rel)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && codeFile.test(entry.name)) files.push(full);
    }
  };
  for (const folder of scannedFolders) {
    try {
      walk(join(root, folder));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && codeFile.test(entry.name)) files.push(join(root, entry.name));
  }
  return files.map((file) => relative(root, file).split(sep).join('/')).sort();
}

/** The 1-based line of a character index. */
function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

/** Blanks every character but line breaks, keeping each `${…}` (no nested braces) as code. */
function keepInterpolations(text: string): string {
  return text.replace(/\$\{([^}]*)\}|[^\n]/g, (_match, expr: string | undefined) =>
    expr === undefined ? ' ' : `  ${expr} `,
  );
}

/**
 * Blanks out comments and the inside of template literals (keeping line breaks), so neither a
 * commented-out import nor text that reads like one is taken for an import. With `codeOnly`, the
 * text of '…' and "…" strings goes too, and template literals keep only their `${…}` code: what
 * the source rules read.
 */
function stripComments(source: string, codeOnly = false): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      const literal = source.slice(i, j + 1);
      const inner = literal.slice(1, -1);
      if (c === '`') {
        out += `\`${codeOnly ? keepInterpolations(inner) : inner.replace(/[^\n]/g, ' ')}\``;
      } else {
        out += codeOnly ? `${c}${inner.replace(/[^\n]/g, ' ')}${c}` : literal;
      }
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const staticImport = /\b(?:import|export)\b([^;'"`()]*?)\bfrom\s*(['"])([^'"\n]+)\2/g;
const sideEffectImport = /\bimport\s*(['"])([^'"\n]+)\1/g;
const callImport = /\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g;
const plainString = /^(['"])([^'"\n]+)\1$/;

function findImports(source: string): ImportRef[] {
  const code = stripComments(source);
  const lineAt = (index: number): number => lineOf(code, index);
  const refs: ImportRef[] = [];
  for (const match of code.matchAll(staticImport)) {
    refs.push({ specifier: match[3], line: lineAt(match.index), names: match[1] ?? '' });
  }
  for (const match of code.matchAll(sideEffectImport)) {
    refs.push({ specifier: match[2], line: lineAt(match.index), names: '' });
  }
  for (const match of code.matchAll(callImport)) {
    const literal = plainString.exec(match[1] ?? '');
    // A dynamic import yields the whole module, reveal() included.
    refs.push({ specifier: literal?.[2], line: lineAt(match.index), names: '*' });
  }
  return refs;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The module a repo-relative path belongs to, or undefined outside src/<module>/. */
function moduleOf(path: string): string | undefined {
  const parts = path.split('/');
  return parts[0] === 'src' && parts.length > 2 ? parts[1] : undefined;
}

function checkFile(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const report = (line: number, rule: string, message: string): void => {
    violations.push({ file, line, rule, message });
  };
  const inSrc = file.startsWith('src/');
  const own = moduleOf(file);
  const rule = own === undefined ? undefined : modules[own];

  if (inSrc && own === undefined) {
    report(1, 'outside-module', 'files under src/ belong to a module folder (src/<module>/)');
    return violations;
  }
  if (own !== undefined && rule === undefined) {
    report(1, 'unknown-module', `"${own}" is not a module of the module map (decision 0009)`);
    return violations;
  }
  const pure = rule?.pure === true || pureFiles.includes(file);

  for (const { specifier, line, names } of findImports(source)) {
    if (specifier === undefined) {
      if (inSrc) report(line, 'computed-import', 'import() and require() take a plain string');
      continue;
    }
    if (specifier.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (target === 'spikes' || target.startsWith('spikes/')) {
        report(line, 'no-spikes', `spike code is never imported ("${specifier}")`);
        continue;
      }
      const targetModule = moduleOf(target);
      if (own !== undefined && targetModule === own) continue;
      if (targetModule === undefined) {
        if (inSrc)
          report(line, 'outside-src', `product code imports nothing outside src/ ("${specifier}")`);
        continue;
      }
      if (target !== `src/${targetModule}/index.ts`) {
        report(
          line,
          'entry-only',
          `import "${targetModule}" through its entry file, src/${targetModule}/index.ts`,
        );
        continue;
      }
      if (own !== undefined && !(rule?.imports ?? []).includes(targetModule)) {
        report(line, 'not-allowed', `"${own}" may not import "${targetModule}" (decision 0009)`);
      } else if (
        inSrc &&
        targetModule === 'secret' &&
        !revealers.includes(own ?? '') &&
        /\breveal\b|\*/.test(names)
      ) {
        report(line, 'reveal-only-transport', 'only transport calls reveal() on a secret');
      } else if (
        inSrc &&
        targetModule === 'secret' &&
        !maskers.includes(own ?? '') &&
        /\bsecretForms\b/.test(names)
      ) {
        report(line, 'forms-only-report', "only report writes a secret's forms (mask lines)");
      }
      continue;
    }
    if (!inSrc) continue;
    if (specifier.startsWith('node:') || isBuiltin(specifier)) {
      const name = specifier.replace(/^node:/, '');
      if (name === 'child_process' || name.startsWith('child_process/')) {
        report(line, 'no-child-process', 'no child processes, no shell (R5, decision 0019)');
      } else if (pure) {
        report(
          line,
          'pure-no-node',
          `"${file}" is pure: it imports no Node built-in ("${specifier}")`,
        );
      }
      continue;
    }
    const name = packageName(specifier);
    if (!(rule?.packages ?? []).includes(name)) {
      report(line, 'package-not-allowed', `"${own}" may not import the package "${name}"`);
    }
  }
  return violations;
}

/** The source rules: brand casts and exit codes in src/, the line cap everywhere. */
function checkSource(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const report = (line: number, rule: string, message: string): void => {
    violations.push({ file, line, rule, message });
  };
  const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  if (lines > maxLines) {
    report(
      maxLines + 1,
      'file-too-long',
      `${lines} lines, the cap is ${maxLines}: split the file by concern`,
    );
  }
  if (!file.startsWith('src/')) return violations;
  const code = stripComments(source, true);
  if (moduleOf(file) !== 'paths') {
    for (const match of code.matchAll(brandCast)) {
      report(
        lineOf(code, match.index),
        'brand-cast',
        'build a RemotePath or ServerPath through paths, which checks it (R10)',
      );
    }
  }
  for (const match of code.matchAll(exitCodeLiteral)) {
    report(
      lineOf(code, match.index),
      'exit-code-literal',
      'name the exit code through ExitCode (contracts), not a bare number',
    );
  }
  return violations;
}

/** One violation per module folder without index.ts, reported on its first file. */
function checkEntries(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const name = moduleOf(file);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    if (modules[name] !== undefined && !files.includes(`src/${name}/index.ts`)) {
      violations.push({
        file,
        line: 1,
        rule: 'missing-entry',
        message: `module "${name}" has no entry file (src/${name}/index.ts)`,
      });
    }
  }
  return violations;
}

function main(): number {
  const root = process.cwd();
  const files = listFiles(root);
  const violations = [
    ...checkEntries(files),
    ...files.flatMap((file) => {
      const source = readFileSync(join(root, file), 'utf8');
      return [...checkFile(file, source), ...checkSource(file, source)];
    }),
  ];
  for (const v of violations) console.error(`${v.file}:${v.line} ${v.rule}: ${v.message}`);
  if (violations.length > 0) {
    console.error(`import rules: ${violations.length} violation(s) in ${files.length} files`);
    return 1;
  }
  console.log(`import rules: ${files.length} files, all imports allowed, all source rules hold`);
  return 0;
}

process.exitCode = main();
