// The GitHub job summary (spec #24 decision 32, 0024 §10), through main(): which runs write one,
// that it is appended once to the file GITHUB_STEP_SUMMARY names, what a file sealup cannot add
// to does, and that the leak check covers it. The words of each scenario are in its golden
// (test/integration/goldens/sNN-*.test.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canaries, createMemoryServer } from '../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  markdown,
  productionConfig,
  runMain,
  summaryFile,
  summaryFooter,
} from '../deploy-kit.ts';

const site = { 'public_html/index.html': '<h1>home</h1>' };

/** A deploy of a one-file site with the canary password, to a fresh memory server. */
function deploy(argv: readonly string[], env: Record<string, string>, tty = false) {
  const project = createProject(productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }), site);
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  return runMain(argv, { cwd: project.root, env, tty, server });
}

describe('job summary', () => {
  it('is appended once, after what the file already holds', async () => {
    const file = summaryFile();
    writeFileSync(file, '## Build\n\nThe build step wrote this.\n');
    const run = await deploy(['deploy', 'production'], { ...inGitHub, GITHUB_STEP_SUMMARY: file });
    expect(run.exitCode).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('## Build\n\nThe build step wrote this.\n### ✅ Sealed up')).toBe(true);
    expect(text.match(/^### /gm)).toHaveLength(1);
    expect(text.endsWith('</sub>\n')).toBe(true);
  });

  it('is written in the GitHub form only: not on a terminal, not in another log', async () => {
    const env = (file: string) => ({ GITHUB_STEP_SUMMARY: file });
    const log = summaryFile();
    await deploy(['deploy', 'production'], env(log));
    const terminal = summaryFile();
    await deploy(['deploy', 'production'], { ...inGitHub, ...env(terminal) }, true);
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(readFileSync(terminal, 'utf8')).toBe('');
  });

  it('is not written when GITHUB_STEP_SUMMARY is empty', async () => {
    const run = await deploy(['deploy', 'production'], { ...inGitHub, GITHUB_STEP_SUMMARY: '' });
    expect(run.exitCode).toBe(0);
    expect(run.summary).toBe('');
  });

  it('is written for deploy only: `sealup` alone, help and check write none', async () => {
    // `sealup` alone is help for the project now (exit 0, T29); check is offline.
    for (const argv of [[], ['help'], ['check']]) {
      const run = await deploy(argv, inGitHub);
      expect(run.exitCode).toBe(0);
      expect(run.summary).toBe('');
    }
  });

  // A problem the page has no summary for: the log's words in the caution box, no target table
  // (none was chosen).
  it('is written for a deploy that stops before reading the config: a flag it does not know', async () => {
    const run = await deploy(['deploy', 'production', '--fast'], inGitHub);
    expect(run.exitCode).toBe(2);
    expect(run.summary).toBe(
      markdown([
        '### ❌ Unknown flag --fast: nothing was changed',
        '',
        '> [!CAUTION]',
        '> Run sealup --help for the commands and flags that work.',
        '>',
        '> Nothing was changed.',
        '',
        summaryFooter('usage'),
      ]),
    );
  });

  it('warns once in the log when the file cannot be added to, and keeps the exit code', async () => {
    const missing = join(dirname(summaryFile()), 'no folder', 'summary');
    const run = await deploy(['deploy', 'production'], {
      ...inGitHub,
      GITHUB_STEP_SUMMARY: missing,
    });
    expect(run.exitCode).toBe(0);
    const warnings = run.stderr.split('\n').filter((line) => line.startsWith('::warning'));
    expect(warnings).toEqual([
      '::warning title=Job summary not written::sealup could not add to the file GITHUB_STEP_SUMMARY names (ENOENT). The log above has the whole run.',
    ]);
  });

  it('keeps a value from ending its code block or table cell early', async () => {
    const config = productionConfig().replace(
      'url: https://example.com',
      'url: https://example.com/?a|b',
    );
    const project = createProject(config, { 'public_html/``` notes.md': 'x' });
    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: { ...inGitHub, PROD_PASSWORD: 'pw-for-tests' },
      server: createMemoryServer({ loginFolder: '/home/deploy' }),
    });
    expect(run.exitCode).toBe(0);
    expect(run.summary).toContain('| Site | https://example.com/?a\\|b |');
    expect(run.summary).toContain('\n````diff\n+ ``` notes.md\n````\n');
  });

  it('is in the leak check: runMain fails a run whose summary holds a canary (R1)', async () => {
    const file = summaryFile();
    writeFileSync(file, `leaked: ${canaries.SEALUP_CANARY_PASSWORD}\n`);
    await expect(
      deploy(['deploy', 'production'], { ...inGitHub, GITHUB_STEP_SUMMARY: file }),
    ).rejects.toThrow('SEALUP_CANARY_PASSWORD leaked in summary as raw');
  });
});
