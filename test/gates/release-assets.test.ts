// The release assets (decision 0017; spec #41 decision 36): scripts/release-assets.ts makes what
// the public release attaches and attests, from a built project: the npm tarball, the action's
// bundle, SHA256SUMS, and the release notes with the action line by its tag (0043). The public
// release.yml and CI's release dry run both call it. Driven here on a copy of the package files
// with stand-in bundles, so no build runs.

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { npmCliPath } from '../../scripts/release-assets.ts';
import { type GateRun, runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'release-assets.ts');

const changelog = [
  '# Changelog',
  '',
  '## [1.2.3](https://github.com/sealup/sealup/compare/v1.2.2...v1.2.3) (2026-10-20)',
  '',
  '',
  '### Bug Fixes',
  '',
  '* a reconnect keeps the host key check',
  '',
  '## [1.2.2](https://github.com/sealup/sealup/compare/v1.2.1...v1.2.2) (2026-10-12)',
  '',
  '### Bug Fixes',
  '',
  '* an older fix',
  '',
].join('\n');

/** A project with the repo's package files at `version`, and stand-in bundles. */
function project(root: string, change: (pkg: Record<string, unknown>) => void = () => {}): void {
  for (const file of ['README.md', 'LICENSE', '.npmrc', 'schema.json']) {
    cpSync(join(repoRoot, file), join(root, file));
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  pkg.version = '1.2.3';
  change(pkg);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'cli.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'dist', 'THIRD_PARTY_LICENSES.txt'), 'none\n');
  writeFileSync(join(root, 'dist', 'action.mjs'), '// the action\n');
}

const hash = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

describe('release output paths are literal arguments', () => {
  it.each(['direct node', 'npm script'])(
    '%s preserves paths without shell expansion',
    async (mode) => {
      const temp = mkdtempSync(join(tmpdir(), 'sealup-release-literal-'));
      try {
        const root = join(temp, 'project');
        mkdirSync(root);
        project(root);
        // All shell effects, including the deliberately harmless commands, stay in this fixture.
        const name =
          process.platform === 'win32'
            ? "out spaces ' & ^ ( ) ; $ %SEALUP_OUT% ! `"
            : "out spaces ' & ; $SEALUP_OUT $(touch sentinel) `touch sentinel-backtick`";
        const out = join(temp, name);
        const notes = join(temp, 'notes.md');
        const args = [script, out, '--root', root, '--notes', notes];
        const env: NodeJS.ProcessEnv = {
          npm_execpath: undefined,
          SEALUP_OUT:
            process.platform === 'win32'
              ? 'expanded" & echo expanded>sentinel & rem "'
              : 'expanded',
        };
        // CI calls node directly: inherited npm_execpath must not mask CLI discovery.
        let result: GateRun;
        if (mode === 'direct node') {
          result = await runNode(args, root, undefined, env);
        } else {
          // npm supplies npm_execpath itself. Only fixed command text crosses its script shell.
          const npm = npmCliPath();
          const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
          pkg.scripts = { release: 'node run-release.mjs' };
          writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
          writeFileSync(
            join(root, 'run-release.mjs'),
            "import { execFileSync } from 'node:child_process';\n" +
              `execFileSync(process.execPath, ${JSON.stringify(args)}, { stdio: 'inherit' });\n`,
          );
          result = await runNode([npm, 'run', 'release'], root, undefined, env);
        }
        expect(existsSync(join(root, 'sentinel')), result.output).toBe(false);
        expect(existsSync(join(root, 'sentinel-backtick')), result.output).toBe(false);
        expect(result.exitCode, result.output).toBe(0);
        expect(readdirSync(out).sort()).toEqual(['SHA256SUMS', 'action.mjs', 'sealup-1.2.3.tgz']);
        expect(readdirSync(temp).sort()).toEqual([name, 'notes.md', 'project'].sort());
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
});

describe('the release assets', () => {
  let temp = '';
  let out = '';
  let notes = '';
  let run: GateRun = { exitCode: -1, output: '' };
  let bad: GateRun = { exitCode: -1, output: '' };
  beforeAll(async () => {
    temp = mkdtempSync(join(tmpdir(), 'sealup-release-assets-'));
    const root = join(temp, 'project');
    const privateRoot = join(temp, 'private');
    mkdirSync(root);
    mkdirSync(privateRoot);
    project(root);
    project(privateRoot, (pkg) => {
      pkg.private = true;
    });
    out = join(temp, 'out');
    notes = join(temp, 'notes.md');
    const args = (from: string, to: string) => [
      script,
      to,
      '--root',
      from,
      '--notes',
      join(temp, `${to === out ? '' : 'bad-'}notes.md`),
    ];
    [run, bad] = await Promise.all([
      runNode(args(root, out), repoRoot),
      runNode(args(privateRoot, join(temp, 'bad-out')), repoRoot),
    ]);
  }, 60_000);
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('writes the tarball, the action bundle and SHA256SUMS, nothing else', () => {
    expect(run.exitCode, run.output).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['SHA256SUMS', 'action.mjs', 'sealup-1.2.3.tgz']);
    expect(readFileSync(join(out, 'action.mjs'), 'utf8')).toBe('// the action\n');
  });

  it('lists both files in SHA256SUMS as `sha256sum -c` reads it', () => {
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toBe(
      `${hash(join(out, 'sealup-1.2.3.tgz'))}  sealup-1.2.3.tgz\n` +
        `${hash(join(out, 'action.mjs'))}  action.mjs\n`,
    );
  });

  it("writes notes with this version's changelog, the action line and the verify commands", () => {
    const text = readFileSync(notes, 'utf8');
    expect(text).toContain('* a reconnect keeps the host key check');
    expect(text).not.toContain('an older fix');
    expect(text).not.toContain('## [1.2.3]');
    expect(text).toContain('```yaml\n- uses: sealup/sealup@v1.2.3\n```');
    expect(text).not.toMatch(/sealup\/sealup@[0-9a-f]{40}/);
    expect(text).toContain('npx sealup@1.2.3 init');
    expect(text).toContain('sha256sum -c SHA256SUMS');
    expect(text).toContain('gh attestation verify sealup-1.2.3.tgz --repo sealup/sealup');
    expect(text).toContain('gh attestation verify action.mjs --repo sealup/sealup');
    expect(text).toContain('npm audit signatures');
  });

  it('stops when the package fails the package gate', () => {
    expect(bad.exitCode, bad.output).toBe(1);
    expect(bad.output).toContain('no-private');
  });

  it.each([
    ['no output folder', [], 'give one output folder'],
    // Since 0043 the notes need no release commit: an old call with --sha is a usage error.
    ['--sha', [join(tmpdir(), 'sealup-never-written'), '--sha', 'abc'], "Unknown option '--sha'"],
  ])('refuses %s', async (_, more, why) => {
    const result = await runNode([script, ...more], repoRoot);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain(why);
  });
});
