// The safety nets as main() prints them (spec #1, seam 2). Only S21 has a page golden; the other
// nets follow its layout (decision 0024 §5: what happened, cause and fix, state line, docs link)
// and, like S21, stop before connecting with no target block (ruling 3). Then the target block of
// a run that connects: the resolved destination, even when it all comes from variables.

import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryServer, goldenText } from '../../src/testkit/index.ts';
import {
  createProject,
  hostKeyFingerprint,
  hostKeyLine,
  productionConfig,
  ref,
  runMain,
  versionLine,
} from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

describe('main: safety nets that stop before connecting', () => {
  it('names a symlink in a source folder, and exits 6', async () => {
    const project = createProject(productionConfig(), {
      'public_html/index.html': 'x',
      'shared/a.txt': 'x',
    });
    symlinkSync(
      join(project.root, 'shared'),
      join(project.root, 'public_html', 'media'),
      'junction',
    );

    // No server: a run that connects fails the test.
    const run = await runMain(['deploy', 'production'], { cwd: project.root, env });

    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy', 'production'),
          '  {rb}✗{/} {b}public_html/media is a symlink: sealup stopped before connecting.{/}',
          '    sealup does not follow links: one could send files from outside the project.',
          '    Put the real file or folder there, or exclude the link.',
          '',
          '    Nothing was changed on production.',
          '    {d}More: sealup.dev/e/symlink{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(6);
  });

  it('says a missing source folder does not exist, and exits 6', async () => {
    const project = createProject(productionConfig({ upload: 'dist' }), { 'src/a.ts': 'x' });
    const run = await runMain(['deploy', 'production'], { cwd: project.root, env });
    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy', 'production'),
          '  {rb}✗{/} {b}dist does not exist: sealup stopped before connecting.{/}',
          '    Deploying without it would delete what sealup put at /home/site.',
          '    Most likely the build failed or wrote its files somewhere else.',
          '    Run your build, check that it makes dist, then deploy again.',
          '    {d}If it is gone for good, remove its upload: entry (line 1).{/}',
          '',
          '    Nothing was changed on production.',
          '    {d}More: sealup.dev/e/empty-source{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(6);
  });

  it('refuses a manifest folder inside the target folder, and exits 2 (ruling 9)', async () => {
    const yaml = productionConfig().replace(
      '    url: https://example.com\n',
      '    url: https://example.com\n    manifest: /home/site/.sealup\n',
    );
    const project = createProject(yaml, { 'public_html/index.html': 'x' });
    const run = await runMain(['deploy', 'production'], { cwd: project.root, env });
    expect(run.stderr).toBe(
      goldenText(
        [
          versionLine('deploy', 'production'),
          '  {rb}✗{/} {b}The manifest folder is inside the target folder: sealup stopped.{/}',
          '    /home/site/.sealup is in /home/site, where upload: sends files (line 1):',
          '    visitors could download it.',
          '    Move manifest: outside it; the default is .sealup in the login folder.',
          '',
          '    sealup did not connect. Nothing was changed on production.',
          '    {d}More: sealup.dev/e/manifest-inside-target{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(2);
  });
});

describe('main: the target block shows where the release goes (R22, R23)', () => {
  // The whole destination from the environment, the host key included.
  const yaml = [
    'upload: public_html',
    'targets:',
    '  production:',
    `    server: sftp://${ref('DEPLOY_USER')}@${ref('DEPLOY_HOST')}:2222${ref('SITE_FOLDER')}`,
    `    password: ${ref('PROD_PASSWORD')}`,
    `    hostKey: ${ref('PROD_HOST_KEY')}`,
    '',
  ].join('\n');
  const destination = {
    DEPLOY_USER: 'deploy',
    DEPLOY_HOST: 'ssh.example.com',
    SITE_FOLDER: '/home/site',
    PROD_HOST_KEY: hostKeyLine,
  };

  it('prints the resolved server URL, port and host key first, then deploys there', async () => {
    const project = createProject(yaml, { 'public_html/index.html': 'x' });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const run = await runMain(['deploy'], {
      cwd: project.root,
      env: { ...env, ...destination },
      server,
    });
    expect(run.stderr.split('\n').slice(0, 4)).toEqual([
      versionLine('deploy'),
      '  production  sftp://deploy@ssh.example.com:2222/home/site',
      `  host key    ${hostKeyFingerprint}  verified`,
      '',
    ]);
    expect(run.exitCode).toBe(0);
    expect(server.files().has('/home/site/index.html')).toBe(true);
  });

  it('stops with exit 2 and no target block when a part of it is not set', async () => {
    const project = createProject(yaml, { 'public_html/index.html': 'x' });
    const { DEPLOY_HOST: _, ...withoutHost } = destination;
    const run = await runMain(['deploy'], { cwd: project.root, env: { ...env, ...withoutHost } });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('DEPLOY_HOST is not set.');
    expect(run.stderr).not.toContain('production  sftp://');
  });
});
