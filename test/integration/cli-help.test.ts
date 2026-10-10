// The commands that only read the project (spec #24 decisions 12 and 13): `sealup` alone and
// `sealup help [topic]`, through main() (seam 2). The page's screens are goldens in
// goldens/s01, s05 and help-screens; this file holds the rules around them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docsSlugs, helpTopics } from '../../src/report/index.ts';
import {
  createProject,
  newProject,
  productionConfig,
  runMain,
  versionLine,
} from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

function project(config = productionConfig()): string {
  return createProject(config, { 'public_html/index.html': 'x' }).root;
}

describe('sealup help [topic]', () => {
  it.each([
    ['check', '  sealup check [target] [flags]'],
    ['help', '  sealup help [topic]'],
  ])('explains %s on stdout, exit 0', async (topic, usage) => {
    const run = await runMain(['help', topic], { cwd: project() });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`USAGE\n${usage}\n`);
    expect(run.stderr).toBe('');
  });

  it('gives the same screen for `<command> --help`', async () => {
    const help = await runMain(['help', 'check'], { cwd: project() });
    const flag = await runMain(['check', '-h'], { cwd: project() });
    expect(flag.stdout).toBe(help.stdout);
  });

  it('answers a mistyped topic with did-you-mean, exit 2', async () => {
    const run = await runMain(['help', 'exit-code'], { cwd: project() });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr.split('\n').slice(0, 4)).toEqual([
      versionLine('help'),
      '  ✗ No help topic named exit-code.',
      '    Did you mean exit-codes?  sealup help exit-codes',
      '    Topics: init, deploy, pull, keyscan, check, help, config, exit-codes.',
    ]);
    expect(run.stderr).toContain('More: sealup.dev/e/usage');
  });

  it('lists the topics without a guess when none is close', async () => {
    const run = await runMain(['help', 'zebra'], { cwd: project() });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      '  ✗ No help topic named zebra.\n    Topics: init, deploy, pull, keyscan, check, help, config, exit-codes.\n',
    );
  });

  it('takes one topic, not two', async () => {
    const run = await runMain(['help', 'deploy', 'check'], { cwd: project() });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('✗ help takes one topic, not 2.');
  });

  it('refuses --json: it prints text only (exit 2, the JSON object on stdout)', async () => {
    const run = await runMain(['help', '--json'], { cwd: project() });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('✗ sealup help prints text only: --json is not taken.');
    expect(JSON.parse(run.stdout)).toMatchObject({ command: 'help', exitCode: 2 });
  });

  it('never mentions sam-sync or --from in the help of init, nor anywhere in help', async () => {
    // The conversion is undocumented (spec #24 decision 22): it shows only to a project that
    // has a .deployment.json, so the help is read in one.
    const root = newProject({ '.deployment.json': '{}', 'dist/index.html': 'x' });
    const runs = [
      [],
      ['--help'],
      ['init', '--help'],
      ['help'],
      ...helpTopics.map((topic) => ['help', topic]),
    ];
    for (const argv of runs) {
      const run = await runMain(argv, { cwd: root });
      expect(`${run.stdout}${run.stderr}`, argv.join(' ')).not.toMatch(
        /sam-sync|--from|deployment\.json|download\.json/,
      );
    }
  });

  it('never names the conversion in the docs: the README, the action, the schema, the slugs', () => {
    const pattern = /sam-sync|--from|deployment\.json|download\.json/;
    for (const file of ['README.md', 'action.yml', 'schema.json']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(pattern);
    }
    expect(docsSlugs.join('\n')).not.toMatch(/sam-sync|samsync|convert/);
  });
});

describe('sealup alone', () => {
  it('prints the config problem of an invalid file, as any command does, exit 2', async () => {
    const run = await runMain([], { cwd: project('upload: [nope'), env });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr.split('\n').slice(0, 2)).toEqual([
      versionLine(),
      '  ✗ sealup.yml has 1 problem.',
    ]);
    expect(run.stderr).toContain('More: sealup.dev/e/config-invalid');
  });

  it('stops on a -c file that does not exist, exit 2', async () => {
    const run = await runMain(['-c', 'other.yml'], { cwd: project(), env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('✗ There is no other.yml here.');
  });

  it('refuses --json: it prints text only (exit 2, usage, the JSON object on stdout)', async () => {
    const run = await runMain(['--json'], { cwd: project(), env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('✗ sealup alone prints text only: --json is not taken.');
    expect(JSON.parse(run.stdout)).toMatchObject({
      command: null,
      status: 'failed',
      exitCode: 2,
      error: { code: 'usage' },
    });
  });
});
