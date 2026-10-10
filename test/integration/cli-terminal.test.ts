// main(argv, env, io) (spec #1, seam 2): what the terminal can show. Colour on a terminal only,
// NO_COLOR and --no-color always win (ruling 5); `√ ×` and an ASCII bar where Unicode is unsafe
// (decision 0024 §3). Platform, terminal flags and environment are injected.

import { describe, expect, it } from 'vitest';
import { createMemoryServer, screenOf } from '../../src/testkit/index.ts';
import { createProject, productionConfig, runMain } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const ansi = '\u001b[';
const site = { 'public_html/index.html': '<h1>home</h1>' };

function deployOn(platform: string, extraEnv: Record<string, string>, tty = true) {
  return runMain(['deploy', '--no-color'], {
    cwd: createProject(productionConfig(), site).root,
    env: { ...env, ...extraEnv },
    tty,
    platform,
    server: createMemoryServer(),
  });
}

describe('colour', () => {
  it('stays on for a terminal when NO_COLOR is empty (no-color.org: present and not empty)', async () => {
    const run = await runMain(['deploy'], {
      cwd: createProject(productionConfig(), site).root,
      env: { ...env, NO_COLOR: '' },
      tty: true,
      server: createMemoryServer(),
    });
    expect(run.stderr).toContain(ansi);
  });

  it('never colours the JSON object, even on a terminal', async () => {
    const run = await runMain(['deploy', '--json'], {
      cwd: createProject(productionConfig(), site).root,
      env,
      tty: true,
      server: createMemoryServer(),
    });
    expect(run.stdout).not.toContain(ansi);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'ok' });
  });
});

describe('symbols where Unicode is unsafe', () => {
  it('uses √, × and a # bar in a legacy Windows console', async () => {
    const run = await deployOn('win32', {});
    expect(screenOf(run.stderr)).toContain('  √ Sealed up and delivered: 1 file to production');
    expect(run.stderr).toContain('  ↑ ##############################   1 / 1 files');
    expect(run.stderr).not.toMatch(/[✓━─]/);

    const failed = await runMain(['deploy', '--no-color', '--frobnicate'], {
      cwd: createProject(productionConfig(), site).root,
      tty: true,
      platform: 'win32',
    });
    expect(failed.stderr).toContain('  × Unknown flag --frobnicate.');
  });

  it.each([
    ['Windows Terminal', 'win32', { WT_SESSION: 'x' }, true],
    ['the VS Code terminal', 'win32', { TERM_PROGRAM: 'vscode' }, true],
    ['CI', 'win32', { CI: 'true' }, true],
    ['a Windows pipe or file', 'win32', {}, false],
    ['a Linux terminal', 'linux', {}, true],
    ['a macOS terminal', 'darwin', {}, true],
  ])('keeps ✓ and the line bar in %s', async (_, platform, extraEnv, tty) => {
    const run = await deployOn(platform, extraEnv, tty);
    expect(screenOf(run.stderr)).toContain('  ✓ Sealed up and delivered:');
  });

  it('falls back on the Linux console (TERM=linux)', async () => {
    const run = await deployOn('linux', { TERM: 'linux' });
    expect(screenOf(run.stderr)).toContain('  √ Sealed up and delivered:');
  });
});
