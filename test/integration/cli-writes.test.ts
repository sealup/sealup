// Files written from a secret as main() prints them (spec #24 decisions 10, 24, 30; seam 2): the
// dry run and `-v` name the file and its variable, never its content or size; `--json` gains
// `written` and `write` ops; GitHub masks each line of a multi-line secret first. The secret is
// the multi-line canary, so runMain's leak check covers every output (R1).

import { describe, expect, it } from 'vitest';
import { canaries, createMemoryServer, goldenText, splitMasks } from '../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  productionConfig,
  ref,
  runMain,
  versionLine,
} from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };
const site = { 'public_html/index.html': '<h1>home</h1>' };
/** The page's production target, with api/.env written from the multi-line canary (line 9). */
const writing = `${productionConfig()}write:\n  api/.env: ${ref('SEALUP_CANARY_MULTILINE')}\n`;

describe('write: what main() prints', () => {
  it('lists the file and its variable in the dry run, never its content or size', async () => {
    const project = createProject(writing, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const run = await runMain(['deploy', '--dry-run'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy'),
          ' {inv} DRY RUN {/} nothing will change on production',
          '  production  sftp://deploy@ssh.example.com:22/home/site',
          '  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  {g}verified{/}',
          '',
          '  {b}First deploy:{/} existing files stay. sealup only ever deletes files it uploaded.',
          // Sizes end at column 72; a secret's size is in no line.
          `  {b}Would upload 1 file{/}${' '.repeat(47)}13 B`,
          `    {g}+{/} index.html${' '.repeat(52)}13 B`,
          '  {b}Would write 1 file from secrets{/}',
          '    {g}+{/} api/.env  {d}from SEALUP_CANARY_MULTILINE{/}',
          '',
          ' {inv} DRY RUN {/} nothing was changed. To apply: {b}sealup deploy production{/}',
        ],
        { color: false },
      ),
    );
  });

  it('counts the write on the plan line, lists it with -v, and counts it as delivered', async () => {
    const project = createProject(writing, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const run = await runMain(['deploy', '-v'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(0);
    const lines = run.stderr.split('\n');
    expect(lines).toContain(`  1 to upload · 1 to write${' '.repeat(42)}13 B`);
    expect(lines).toContain('    + api/.env  from SEALUP_CANARY_MULTILINE');
    expect(lines).toContain('  ✓ Sealed up and delivered: 2 files to production in 0.0 s.');
  });

  it('gives written and the write op in --json, without a size', async () => {
    const project = createProject(writing, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const dry = await runMain(['deploy', '--dry-run', '--json'], {
      cwd: project.root,
      env,
      server,
    });
    const real = await runMain(['deploy', '--json'], { cwd: project.root, env, server });
    const again = await runMain(['deploy', '--json'], { cwd: project.root, env, server });

    expect(JSON.parse(dry.stdout)).toMatchObject({
      uploaded: 1,
      written: 1,
      ops: [
        { op: 'upload', path: 'index.html', reason: 'new', size: 13 },
        { op: 'write', path: 'api/.env', reason: 'new', size: null },
      ],
    });
    expect(JSON.parse(real.stdout)).toMatchObject({ status: 'ok', uploaded: 1, written: 1 });
    expect(JSON.parse(again.stdout)).toMatchObject({
      status: 'unchanged',
      written: 0,
      unchanged: 2,
    });
  });

  it('masks the whole multi-line secret and each of its lines in GitHub, before anything else', async () => {
    const project = createProject(writing, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const run = await runMain(['deploy', '--dry-run'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      server,
    });

    const { masks, rest } = splitMasks(run.stderr);
    const [first, second] = canaries.SEALUP_CANARY_MULTILINE.split('\n');
    // As GitHub reads them back: `%` and the line break escaped (decision 30's `%0A` whole).
    const asGitHub = (text: string) => text.replaceAll('%', '%25').replaceAll('\n', '%0A');
    const lines = masks.split('\n');
    expect(lines).toContain(`::add-mask::${asGitHub(canaries.SEALUP_CANARY_MULTILINE)}`);
    expect(lines).toContain(`::add-mask::${asGitHub(first ?? '')}`);
    expect(lines).toContain(`::add-mask::${asGitHub(second ?? '')}`);
    // The password's mask is there too, as before.
    expect(lines).toContain('::add-mask::pw-for-tests');
    expect(rest.split('\n')[0]).toBe(versionLine('deploy'));
    expect(run.exitCode).toBe(0);
  });

  it('says which file from a secret was not written when the run stops part-way', async () => {
    const project = createProject(writing, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    // The lock's note (decision 0031) is the first put, the upload the second, the write the third.
    server.faults.failWrite(3, 'permission');

    const run = await runMain(['deploy'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(1);
    expect(run.stderr.split('\n').slice(-7)).toEqual([
      '  ✗ Deploy stopped: ssh.example.com refused a change: permission denied.',
      '    Check that deploy may write in /home/site on ssh.example.com.',
      '',
      '    production has every uploaded file; 1 of 1 file from secrets was not written.',
      '    Run the same command again to finish.',
      '    More: sealup.dev/e/permission-denied',
      '',
    ]);
  });

  it('counts and lists the write in the job summary, never its size or content', async () => {
    const project = createProject(writing, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const github = { ...env, ...inGitHub };

    const dry = await runMain(['deploy', '--dry-run'], { cwd: project.root, env: github, server });
    const real = await runMain(['deploy'], { cwd: project.root, env: github, server });

    // runMain's leak check read both summaries: the multi-line canary is in neither.
    expect(dry.summary).toContain('| Would write | 1 | |');
    expect(dry.summary).toContain('+ index.html\n+ api/.env  from SEALUP_CANARY_MULTILINE\n');
    expect(dry.summary).toContain('Changes (2)');
    expect(real.summary).toContain('### ✅ Sealed up and delivered: 2 files to production');
    expect(real.summary).toContain('| Written | 1 | |');
  });

  it("counts and lists the write in GitHub's change group", async () => {
    const project = createProject(writing, site);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });

    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { ...env, ...inGitHub, NO_COLOR: '1' },
      server,
    });

    const { rest } = splitMasks(run.stderr);
    expect(rest).toContain(
      [
        '::group::Changes: 1 upload, 1 write',
        `    + index.html${' '.repeat(52)}13 B`,
        '    + api/.env  from SEALUP_CANARY_MULTILINE',
        '::endgroup::',
      ].join('\n'),
    );
  });

  it('words a write that holds its content in sealup.yml, at its line, never the value', async () => {
    const project = createProject(
      `${productionConfig()}write:\n  api/.env: APP_KEY=fake-x1\n`,
      site,
    );

    const run = await runMain(['deploy'], { cwd: project.root, env });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  ✗ sealup.yml has 1 problem.',
        `    write.api/.env (line 9): holds the file's content; write one ${ref('NAME')}`,
        '',
        '    sealup did not connect. Nothing was changed.',
        '    More: sealup.dev/e/config-invalid',
        '',
      ].join('\n'),
    );
    expect(run.stderr).not.toContain('fake-x1');
  });

  it('words the public-folder net, with the line to change, before connecting (exit 6)', async () => {
    const project = createProject(
      `${productionConfig()}write:\n  www/config.php: ${ref('SEALUP_CANARY_MULTILINE')}\n`,
      site,
    );

    const run = await runMain(['deploy'], { cwd: project.root, env });

    expect(run.exitCode).toBe(6);
    expect(run.stderr).toBe(
      [
        versionLine('deploy'),
        '  ✗ A file written from a secret would land in a public folder: sealup stopped.',
        '    write.www/config.php (line 9) writes /home/site/www/config.php,',
        '    inside www/, where visitors could download it.',
        '    Write it outside the web folder. If www/ is not served, add',
        '    allowPublic: true to that entry.',
        '',
        '    sealup did not connect. Nothing was changed on production.',
        '    More: sealup.dev/e/secret-file-public',
        '',
      ].join('\n'),
    );

    const github = await runMain(['deploy'], { cwd: project.root, env: { ...env, ...inGitHub } });
    expect(github.stderr).toContain(
      '::error file=sealup.yml,line=9,title=Secret file in a public folder::write.www/config.php writes /home/site/www/config.php, inside www/, where visitors could download it. Write it outside the web folder, or add allowPublic: true to that entry if www/ is not served. Nothing was changed on production.\n',
    );
  });
});
