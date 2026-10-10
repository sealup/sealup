// The three forms of the same words (spec #24 decisions 27-31, 0024 §1, §8, §9), chosen by the
// CLI: terminal (stderr is a terminal), GitHub (GITHUB_ACTIONS=true and stderr is not a
// terminal), log (anything else). Driven through main() with injected I/O against the memory
// server; the goldens hold each scenario's full lines, this file the rules between them.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canaries,
  createMemoryServer,
  findLeaks,
  screenOf,
  splitMasks,
} from '../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  newProject,
  productionConfig,
  ref,
  runMain,
} from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const site = { 'public_html/index.html': '<h1>home</h1>' };

describe('the log form (no terminal, not GitHub)', () => {
  it('starts with the version line: sealup <version> · <command> [target], no flag', async () => {
    const project = createProject(productionConfig(), site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const run = await runMain(['deploy', '-n', 'production', '-c', 'sealup.yml'], {
      cwd: project.root,
      env,
      server,
    });
    expect(run.stderr.split('\n')[0]).toBe('sealup 0.0.0-source · deploy production');
    expect(run.exitCode).toBe(0);
  });

  // Spec #24 decision 27: the version line never carries a typed value. A password typed in
  // --server's URL (refused, R3) would otherwise reach the log, never registered as a Secret.
  it.each([
    ['log', {}],
    ['GitHub', inGitHub],
  ])('never repeats a value typed on the command line (%s form)', async (_form, formEnv) => {
    const root = newProject({});
    const typed = `sftp://deploy:${encodeURIComponent(canaries.SEALUP_CANARY_PASSWORD)}@ssh.example.com/x`;
    // runMain's leak check fails the test on any form of the canary in what main() printed.
    const run = await runMain(['init', '--server', typed], { cwd: root, env: formEnv });
    expect(run.exitCode).toBe(2);
    expect(splitMasks(run.stderr).rest.split('\n')[0]).toBe('sealup 0.0.0-source · init');
  });

  it('names no command it does not know, and no extra word', async () => {
    const root = newProject({});
    const unknown = await runMain(['sftp://deploy:pw-typed@ssh.example.com'], { cwd: root });
    const extra = await runMain(['init', 'pw-typed-here'], { cwd: root });
    const help = await runMain(['help', 'pw-typed-here'], { cwd: root });
    expect(unknown.stderr.split('\n')[0]).toBe('sealup 0.0.0-source');
    expect(extra.stderr.split('\n')[0]).toBe('sealup 0.0.0-source · init');
    expect(help.stderr.split('\n')[0]).toBe('sealup 0.0.0-source · help');
  });

  it('ends a run that delivered with the timing line, under the result, not dim', async () => {
    const project = createProject(productionConfig(), site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const first = await runMain(['deploy'], { cwd: project.root, env, server });
    const again = await runMain(['deploy'], { cwd: project.root, env, server });
    expect(first.stderr.split('\n').slice(-3)).toEqual([
      '    https://example.com',
      '    connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s',
      '',
    ]);
    // Nothing was sent: no transfer phase to time (S09's CI form).
    expect(again.stderr.split('\n').slice(-3)).toEqual([
      '    https://example.com',
      '    connect 0.0 s · scan 0.0 s · compare 0.0 s',
      '',
    ]);
  });

  it('has no timing line after a dry run or an error (S10, S16 CI forms)', async () => {
    const project = createProject(productionConfig(), site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const dry = await runMain(['deploy', '-n'], { cwd: project.root, env, server });
    const failed = await runMain(['deploy', 'nope'], { cwd: project.root, env, server });
    expect(dry.stderr).not.toContain('connect');
    expect(failed.stderr).not.toContain('connect');
  });

  it('lists the changes only with -v (a plain log has no group to fold them in)', async () => {
    const project = createProject(productionConfig(), site);
    const quiet = await runMain(['deploy'], {
      cwd: project.root,
      env,
      server: createMemoryServer(),
    });
    const verbose = await runMain(['deploy', '-v'], {
      cwd: project.root,
      env,
      server: createMemoryServer(),
    });
    expect(quiet.stderr).not.toContain('+ index.html');
    expect(verbose.stderr).toContain(`    + index.html${' '.repeat(52)}13 B\n`);
  });

  it('has no colour, even in CI', async () => {
    const project = createProject(productionConfig(), site);
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { ...env, CI: 'true' },
      server: createMemoryServer(),
    });
    expect(run.stderr).not.toContain(ansi);
  });
});

const ansi = '\u001b[';

/** A site deployed once, then rebuilt: one new file, one changed, one gone, one excluded now. */
async function changedSite() {
  const project = createProject(productionConfig(), {
    'public_html/index.html': 'v1',
    'public_html/old.js': 'old',
    'public_html/robots.txt': 'all',
  });
  const server = createMemoryServer();
  await runMain(['deploy'], { cwd: project.root, env, server });
  const at = (path: string): string => join(project.root, 'public_html', path);
  writeFileSync(at('index.html'), 'v2');
  writeFileSync(at('new.js'), 'new');
  rmSync(at('old.js'));
  const excluding = 'exclude: [public_html/robots.txt]\ntargets:';
  writeFileSync(project.config, productionConfig().replace('targets:', excluding));
  return { root: project.root, server };
}
const github = { ...env, GITHUB_ACTIONS: 'true' };

describe('the GitHub form (GITHUB_ACTIONS=true, no terminal)', () => {
  it('has colour, as GitHub renders it, unless NO_COLOR or --no-color says no (0024 §8)', async () => {
    const project = createProject(productionConfig(), site);
    const run = (extra: Record<string, string>, ...flags: string[]) =>
      runMain(['deploy', ...flags], {
        cwd: project.root,
        env: { ...github, ...extra },
        server: createMemoryServer(),
      });
    expect((await run({})).stderr).toContain(ansi);
    expect((await run({ NO_COLOR: '1' })).stderr).not.toContain(ansi);
    expect((await run({}, '--no-color')).stderr).not.toContain(ansi);
  });

  it('is the terminal form when stderr is a terminal, GitHub or not', async () => {
    const project = createProject(productionConfig(), site);
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: github,
      tty: true,
      server: createMemoryServer(),
    });
    expect(run.stderr).not.toContain('sealup 0.0.0-source');
    expect(run.stderr).not.toContain('::');
  });

  it('masks every form of each secret before any other byte (R2), then the version line', async () => {
    const project = createProject(productionConfig(), site);
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: github,
      server: createMemoryServer(),
    });
    // pw-for-tests: as it is (also its URL and JSON forms), base64 (also base64url), hex, HEX.
    expect(run.stderr.split('\n').slice(0, 5)).toEqual([
      '::add-mask::pw-for-tests',
      '::add-mask::cHctZm9yLXRlc3Rz',
      '::add-mask::70772d666f722d7465737473',
      '::add-mask::70772D666F722D7465737473',
      'sealup 0.0.0-source · deploy',
    ]);
    expect(run.stderr.split('\n').slice(5).join('\n')).not.toContain('add-mask');
  });

  it('writes the canary only on its mask lines, escaped as GitHub reads them back', async () => {
    const project = createProject(productionConfig({ password: 'SEALUP_CANARY_PASSWORD' }), site);
    // runMain's leak check reads everything after the leading mask lines.
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: github,
      server: createMemoryServer(),
    });
    const { masks } = splitMasks(run.stderr);
    // `%` is GitHub's escape character: %25 is read back as the canary's own `%`.
    expect(masks.split('\n')[0]).toBe(`::add-mask::Cn4ry-pw"'$/+=%25\\x7Qz-fake`);
    expect(findLeaks({ masks }).length).toBeGreaterThan(0);
    expect(run.exitCode).toBe(0);
  });

  it('masks every target’s secret, a target that cannot be used included', async () => {
    const config = [
      productionConfig(),
      '  staging:',
      '    server: ftp://deploy@ssh.example.com/home/site',
      `    password: ${ref('STAGING_PASSWORD')}`,
    ].join('\n');
    const project = createProject(config, site);
    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: { ...github, STAGING_PASSWORD: 'staging-secret' },
      server: createMemoryServer(),
    });
    expect(run.stderr).toContain('::add-mask::staging-secret\n');
  });

  it('masks a password written in sealup.yml as its first line, and never prints it (S15)', async () => {
    const config = productionConfig().replace(ref('PROD_PASSWORD'), 'written-in-the-file');
    const project = createProject(config, site);
    const run = await runMain(['deploy'], { cwd: project.root, env: github });
    expect(run.stderr.split('\n')[0]).toBe('::add-mask::written-in-the-file');
    expect(splitMasks(run.stderr).rest).not.toContain('written-in-the-file');
    expect(run.exitCode).toBe(2);
  });

  it('folds every change in a group before the result, -v or not (0024 §7, §9)', async () => {
    const group = [
      '  2 to upload · 1 to delete                                          5 B',
      '::group::Changes: 2 upload, 1 delete, 1 keep',
      `    + new.js${' '.repeat(57)}3 B`,
      `    ~ index.html${' '.repeat(53)}2 B`,
      '    - old.js',
      '    · robots.txt  excluded now, never deleted',
      '::endgroup::',
      '',
      '  ✓ Sealed up and delivered: 2 files to production in 0.0 s.',
    ];
    for (const flags of [[], ['-v']]) {
      const { root, server } = await changedSite();
      const argv = ['deploy', '--no-color', ...flags];
      const run = await runMain(argv, { cwd: root, env: github, server });
      const lines = run.stderr.split('\n');
      const plan = lines.findIndex((line) => line.includes('to upload'));
      expect(lines.slice(plan, plan + group.length)).toEqual(group);
    }
  });

  it('has no group when nothing changed, nor on a dry run, which lists every change', async () => {
    const project = createProject(productionConfig(), site);
    const server = createMemoryServer();
    const dry = await runMain(['deploy', '-n', '--no-color'], {
      cwd: project.root,
      env: github,
      server,
    });
    await runMain(['deploy'], { cwd: project.root, env, server });
    const again = await runMain(['deploy'], { cwd: project.root, env: github, server });
    expect(dry.stderr).not.toContain('::group::');
    expect(dry.stderr).toContain('    + index.html');
    expect(again.stderr).not.toContain('::group::');
  });

  it('starts with the version line when there is no secret to mask', async () => {
    const project = createProject(productionConfig(), site);
    const run = await runMain(['deploy', '--frobnicate'], { cwd: project.root, env: github });
    expect(run.stderr.split('\n')[0]).toBe('sealup 0.0.0-source · deploy');
  });
});

describe('-q, a quiet run (spec #24 decision 17)', () => {
  const block = [
    '  production  sftp://deploy@ssh.example.com:22/home/site',
    '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified',
    '',
  ];

  it('keeps the target block (R22) and the result line, nothing else', async () => {
    const { root, server } = await changedSite();
    const run = await runMain(['deploy', '-q'], { cwd: root, env, server });
    expect(run.stderr.split('\n')).toEqual([
      'sealup 0.0.0-source · deploy',
      ...block,
      '  ✓ Sealed up and delivered: 2 files to production in 0.0 s.',
      '',
    ]);
    expect(run.exitCode).toBe(0);
  });

  it('is the same on a terminal, without the version line', async () => {
    const { root, server } = await changedSite();
    const run = await runMain(['deploy', '--quiet'], {
      cwd: root,
      env: { ...env, NO_COLOR: '1' },
      tty: true,
      server,
    });
    expect(screenOf(run.stderr).split('\n')).toEqual([
      ...block,
      '  ✓ Sealed up and delivered: 2 files to production in 0.0 s.',
      '',
    ]);
  });

  it('keeps the masks and the version line in GitHub, and drops the group', async () => {
    const { root, server } = await changedSite();
    const run = await runMain(['deploy', '-q', '--no-color'], { cwd: root, env: github, server });
    expect(splitMasks(run.stderr).rest.split('\n')).toEqual([
      'sealup 0.0.0-source · deploy',
      ...block,
      '  ✓ Sealed up and delivered: 2 files to production in 0.0 s.',
      '',
    ]);
  });

  it('keeps every error line', async () => {
    const project = createProject(productionConfig({ hostKey: false }), site);
    const quiet = await runMain(['deploy', '-q'], { cwd: project.root, env });
    const full = await runMain(['deploy'], { cwd: project.root, env });
    expect(quiet.stderr.split('\n').slice(1)).toEqual(full.stderr.split('\n').slice(1));
    expect(quiet.exitCode).toBe(4);
  });

  it('keeps a dry run’s labels and drops its list', async () => {
    const { root, server } = await changedSite();
    const run = await runMain(['deploy', '-n', '-q'], { cwd: root, env, server });
    expect(run.stderr.split('\n')).toEqual([
      'sealup 0.0.0-source · deploy',
      '  DRY RUN  nothing will change on production',
      ...block,
      '  DRY RUN  nothing was changed. To apply: sealup deploy production',
      '',
    ]);
  });

  it('is refused with -v, exit 2: never a half-quiet mix', async () => {
    const project = createProject(productionConfig(), site);
    const run = await runMain(['deploy', '-q', '-v'], { cwd: project.root, env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.split('\n').slice(1, 3)).toEqual([
      '  ✗ -q and -v cannot be used together.',
      '    Run sealup --help for the commands and flags that work.',
    ]);
  });
});

describe("the GitHub form's annotations (spec #24 decision 31)", () => {
  const annotations = (stderr: string): string[] =>
    stderr.split('\n').filter((line) => /^::(error|warning|notice)\b/.test(line));

  it('ends a problem with one annotation: its title, then its fix and state', async () => {
    const project = createProject(productionConfig(), site);
    const run = await runMain(['deploy', '--frobnicate'], { cwd: project.root, env: github });
    const lines = run.stderr.split('\n');
    expect(annotations(run.stderr)).toEqual([
      '::error title=Unknown flag --frobnicate::Run sealup --help for the commands and flags that work. Nothing was changed.',
    ]);
    expect(lines.at(-2)).toBe(annotations(run.stderr)[0]);
  });

  it('names the action’s target input when no target was named (page S12)', async () => {
    const config = [productionConfig(), '  staging:', ...productionConfig().split('\n').slice(3)];
    const project = createProject(config.join('\n'), site);
    const run = await runMain(['deploy'], { cwd: project.root, env: github });
    expect(annotations(run.stderr)).toEqual([
      "::error title=No target named::sealup.yml has 2 targets (production, staging) and none was named. Set the action's target input, or run sealup deploy production or sealup deploy staging.",
    ]);
  });

  it('gives each config issue its own, at its line of the file, from the workspace', async () => {
    const config = productionConfig().replace('targets:', 'parallel: lots\nretries: 3\ntargets:');
    const root = createProject('', { 'site/sealup.yml': config, 'site/public_html/a': 'x' }).root;
    const run = await runMain(['deploy', '-c', 'site/sealup.yml'], {
      cwd: root,
      env: { ...github, GITHUB_WORKSPACE: root },
    });
    expect(annotations(run.stderr)).toEqual([
      '::error file=site/sealup.yml,line=2,title=parallel::Write a whole number from 1 to 256.',
      '::error file=site/sealup.yml,line=3,title=retries::Unknown key; sealup stops on it.',
    ]);
    expect(run.exitCode).toBe(2);
  });

  it('gives at most 10 per level, as GitHub shows no more; the log keeps them all', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `extra${i}: 1`).join('\n');
    const config = productionConfig().replace('targets:', `${keys}\ntargets:`);
    const project = createProject(config, site);
    const run = await runMain(['deploy'], { cwd: project.root, env: github });
    expect(annotations(run.stderr)).toHaveLength(10);
    expect(run.stderr).toContain('    extra11 (line 13): unknown key; sealup stops on it\n');
  });

  it("escapes values as GitHub's toolkit does: % CR LF, and : , in properties", async () => {
    const config = productionConfig().replace('targets:', '"a,b:c%": 1\ntargets:');
    const project = createProject(config, site);
    const run = await runMain(['deploy'], { cwd: project.root, env: github });
    expect(annotations(run.stderr)).toEqual([
      '::error file=sealup.yml,line=2,title=a%2Cb%3Ac%25::Unknown key; sealup stops on it.',
    ]);
  });
});
