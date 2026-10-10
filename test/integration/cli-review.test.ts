// main(argv, env, io) (spec #1, seam 2): the review step. `-n` shows every change and the
// command that applies it; `-v` lists every change on a real run, with a timing line (spec
// stories 23, 26-30; decision 0024 §4, §7). Every run here goes through the leak check.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryServer, screenOf } from '../../src/testkit/index.ts';
import { createProject, inGitHub, productionConfig, runMain, versionLine } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const block = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified',
  '',
];

/** A project deployed once to a memory server; its build can then change. */
async function deployed(files: Record<string, string>, config = productionConfig()) {
  const project = createProject(config, files);
  const server = createMemoryServer();
  await runMain(['deploy'], { cwd: project.root, env, server });
  const at = (path: string): string => join(project.root, ...path.split('/'));
  return { root: project.root, server, at };
}

describe('-v on a real run', () => {
  // On a terminal, colour off: the terminal form of -v (the log forms are in cli-forms.test.ts).
  const onTerminal = { env: { ...env, NO_COLOR: '1' }, tty: true };

  it('lists every change under the plan line and the timings under the result', async () => {
    const s = await deployed({
      'public_html/index.html': 'v1',
      'public_html/old.js': 'v1',
      'public_html/same.js': 'v1',
    });
    writeFileSync(s.at('public_html/index.html'), 'v2');
    writeFileSync(s.at('public_html/new.js'), 'v2');
    rmSync(s.at('public_html/old.js'));

    const run = await runMain(['deploy', '-v'], { ...onTerminal, cwd: s.root, server: s.server });

    expect(run.exitCode).toBe(0);
    expect(screenOf(run.stderr)).toBe(
      [
        ...block,
        '  2 to upload · 1 to delete · 1 unchanged                            4 B',
        '    + new.js                                                         2 B',
        '    ~ index.html                                                     2 B',
        '    - old.js',
        '',
        '  ✓ Sealed up and delivered: 2 files to production in 0.0 s.',
        '    1 old file removed · https://example.com',
        '    connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s',
        '',
      ].join('\n'),
    );
  });

  it('says what a run that only deletes did, not "delivered: 0 files"', async () => {
    const build = { 'public_html/index.html': 'v1', 'public_html/old.js': 'v1' };
    const s = await deployed(build);
    rmSync(s.at('public_html/old.js'));
    const ci = await deployed(build);
    rmSync(ci.at('public_html/old.js'));

    const run = await runMain(['deploy'], { ...onTerminal, cwd: s.root, server: s.server });
    const summary = await runMain(['deploy'], {
      env: { ...env, ...inGitHub },
      cwd: ci.root,
      server: ci.server,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stderr.split('\n').slice(3)).toEqual([
      '  0 to upload · 1 to delete · 1 unchanged                            0 B',
      '',
      '  ✓ Cleaned up: 1 old file removed from production in 0.0 s.',
      '    https://example.com',
      '',
    ]);
    expect(summary.summary).toContain(
      '### ✅ Cleaned up: 1 old file removed from production in 0.0 s',
    );
  });

  it('adds only the timing line when nothing changed', async () => {
    const s = await deployed({ 'public_html/index.html': 'v1' });
    const run = await runMain(['deploy', '--verbose'], {
      ...onTerminal,
      cwd: s.root,
      server: s.server,
    });
    expect(run.stderr.split('\n').slice(3)).toEqual([
      '  ✓ Already up to date: 1 file checked on production in 0.0 s.',
      '    https://example.com',
      '    connect 0.0 s · scan 0.0 s · compare 0.0 s · transfer 0.0 s',
      '',
    ]);
  });
});

describe('-n, --dry-run', () => {
  it('puts the delete note on its own line when the count would push it past 80 columns', async () => {
    const files: Record<string, string> = { 'public_html/index.html': 'v1' };
    for (let i = 0; i < 10; i++) files[`public_html/old${i}.js`] = 'v1';
    const s = await deployed(files);
    for (let i = 0; i < 10; i++) rmSync(s.at(`public_html/old${i}.js`));

    const run = await runMain(['deploy', '-n'], { cwd: s.root, env, server: s.server });

    const lines = run.stderr.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    const head = lines.indexOf('  Would delete 10 files');
    expect(lines[head + 1]).toBe('    (sealup uploaded them; they are no longer in your build)');
    expect(lines[head + 2]).toBe('    - old0.js');
  });

  it('shows a first deploy with its notice, and changes nothing', async () => {
    const project = createProject(productionConfig(), { 'public_html/index.html': 'x'.repeat(12) });
    const server = createMemoryServer();
    const files = server.files();

    const run = await runMain(['deploy', '--dry-run'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  DRY RUN  nothing will change on production',
        ...block,
        '  First deploy: existing files stay. sealup only ever deletes files it uploaded.',
        '  Would upload 1 file                                               12 B',
        '    + index.html                                                    12 B',
        '',
        '  DRY RUN  nothing was changed. To apply: sealup deploy production',
        '',
      ].join('\n'),
    );
    expect(server.files()).toEqual(files);
  });

  it('says nothing would change when the server is up to date', async () => {
    const s = await deployed({ 'public_html/index.html': 'v1' });
    const run = await runMain(['deploy', '-n'], { cwd: s.root, env, server: s.server });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.split('\n').slice(5)).toEqual([
      '  Nothing would change.',
      '  1 unchanged',
      '',
      '  DRY RUN  nothing was changed. To apply: sealup deploy production',
      '',
    ]);
  });

  it('ends with the exact command to apply it: the target and the config file', async () => {
    const root = createProject('', {
      'my site/sealup.yml': productionConfig(),
      'my site/public_html/index.html': 'x',
    }).root;
    const server = createMemoryServer();
    const run = await runMain(['deploy', '-n', '-c', 'my site/sealup.yml'], {
      cwd: root,
      env,
      server,
    });
    expect(run.stderr.split('\n').at(-2)).toBe(
      '  DRY RUN  nothing was changed. To apply: sealup deploy production -c "my site/sealup.yml"',
    );
  });

  it('shows a path too long for its line in full, over several lines inside 80 columns', async () => {
    const deep = `${'a-rather-long-folder-name/'.repeat(4)}${'file-name-'.repeat(5)}.js`;
    const project = createProject(productionConfig(), { [`public_html/${deep}`]: 'x' });
    const run = await runMain(['deploy', '-n'], {
      cwd: project.root,
      env,
      server: createMemoryServer(),
    });

    const lines = run.stderr.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    const start = lines.findIndex((line) => line.startsWith('    + '));
    const entry = lines.slice(start, lines.indexOf('', start));
    expect(entry.length).toBeGreaterThan(1);
    expect(entry.at(-1)).toMatch(/ {2}1 B$/);
    expect(entry.at(-1)).toHaveLength(72);
    const path = entry.map((line, i) => (i === 0 ? line.slice(6) : line.trimStart())).join('');
    expect(path.replace(/ +1 B$/, '')).toBe(deep);
  });
});

describe('--help (ruling 8: what works now, in the page wording)', () => {
  it('lists -n, --json and -v, and the dry run example', async () => {
    const root = createProject(productionConfig(), {}).root;
    const run = await runMain(['--help'], { cwd: root });
    expect(run.stdout).toContain(
      [
        '  -c, --config <file>     Use this config file (default: sealup.yml)',
        '      --env-file <file>   Read variables from this file (default: sealup.env)',
        '  -n, --dry-run           Show every change, change nothing',
        '      --json              Print one JSON object on stdout',
        '  -v, --verbose           Show the file list and timings',
        '  -q, --quiet             Show the result line only',
        '      --no-color          No colour (NO_COLOR works too)',
      ].join('\n'),
    );
    expect(run.stdout).toContain('  $ sealup deploy -n\n  $ sealup deploy production\n');
  });
});
