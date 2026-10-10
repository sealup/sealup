// init (spec #24 decisions 19 and 21): what it finds in a project (the upload folder and its
// file count, the build command from package.json and the lockfile, the Node version file, the
// files already there) and the GitHub workflow it writes (exploration 06 §5.1, 0024 §11).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { readProject, workflowText } from '../../src/init/index.ts';
import { tempFolder } from '../config-kit.ts';

function project(files: Readonly<Record<string, string>>): string {
  const root = tempFolder();
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const buildScript = JSON.stringify({ scripts: { build: 'vite build' } });

describe('readProject: the upload folder', () => {
  it('takes the first of dist, build, out, public, _site that holds files, with its count', async () => {
    const root = project({
      '_site/a.html': 'a',
      'public/b/c.html': 'c',
      'public/d.html': 'd',
    });
    mkdirSync(join(root, 'dist', 'empty'), { recursive: true });
    const found = await readProject(root);
    expect(found.upload).toEqual({ folder: 'public', files: 2 });
  });

  it('counts the files in every folder below it', async () => {
    const root = project({
      'dist/index.html': 'x',
      'dist/assets/a.js': 'a',
      'dist/assets/b/c.css': 'c',
    });
    expect((await readProject(root)).upload).toEqual({ folder: 'dist', files: 3 });
  });

  it('finds none when each is missing or empty', async () => {
    const root = project({ 'src/main.ts': 'x' });
    mkdirSync(join(root, 'dist'));
    expect((await readProject(root)).upload).toBeUndefined();
  });
});

describe('readProject: the build command', () => {
  it.each([
    [{}, { manager: 'npm', install: 'npm install', run: 'npm run build' }],
    [{ 'package-lock.json': '{}' }, { manager: 'npm', install: 'npm ci', run: 'npm run build' }],
    [
      { 'pnpm-lock.yaml': '' },
      {
        manager: 'pnpm',
        install: 'corepack enable && pnpm install --frozen-lockfile',
        run: 'pnpm run build',
      },
    ],
    [
      { 'yarn.lock': '' },
      {
        manager: 'yarn',
        install: 'corepack enable && yarn install --frozen-lockfile',
        run: 'yarn run build',
      },
    ],
  ])('reads the package manager from the lockfile: %j', async (lockfile, build) => {
    const root = project({ 'package.json': buildScript, ...lockfile });
    expect((await readProject(root)).build).toEqual(build);
  });

  it('has none without a build script, or without package.json', async () => {
    expect(
      (await readProject(project({ 'package.json': '{"scripts":{}}' }))).build,
    ).toBeUndefined();
    expect((await readProject(project({}))).build).toBeUndefined();
    expect((await readProject(project({ 'package.json': 'not json' }))).build).toBeUndefined();
  });

  it('names the Node version file, .nvmrc first', async () => {
    expect((await readProject(project({ '.node-version': '24' }))).nodeVersionFile).toBe(
      '.node-version',
    );
    const both = project({ '.node-version': '24', '.nvmrc': '24' });
    expect((await readProject(both)).nodeVersionFile).toBe('.nvmrc');
    expect((await readProject(project({}))).nodeVersionFile).toBeUndefined();
  });
});

describe('readProject: what is there already', () => {
  it('finds sealup.yml or sealup.yaml, the workflow, the password in sealup.env, .deployment.json', async () => {
    const root = project({
      'sealup.yaml': 'x',
      '.github/workflows/deploy.yml': 'x',
      'sealup.env': 'SEALUP_PASSWORD=already-set\n',
      '.deployment.json': '{}',
      '.git/HEAD': 'ref: refs/heads/main',
    });
    const found = await readProject(root);
    expect(found.existingConfig).toBe(join(root, 'sealup.yaml'));
    expect(found.workflow).toEqual({
      file: join(root, '.github', 'workflows', 'deploy.yml'),
      exists: true,
    });
    expect(found.envHasPassword).toBe(true);
    expect(found.deploymentJson).toBe(true);
  });

  it('puts the workflow at the repo root, and says where the project is from there', async () => {
    const root = project({ '.git/HEAD': 'ref: refs/heads/main', 'site/dist/a.html': 'a' });
    const found = await readProject(join(root, 'site'));
    expect(found.workflow).toEqual({
      file: join(root, '.github', 'workflows', 'deploy.yml'),
      exists: false,
    });
    expect(found.fromRepoRoot).toBe('site');
  });

  it('finds nothing in a new project', async () => {
    const found = await readProject(project({}));
    expect(found.existingConfig).toBeUndefined();
    expect(found.workflow.exists).toBe(false);
    expect(found.envHasPassword).toBe(false);
    expect(found.deploymentJson).toBe(false);
    expect(found.fromRepoRoot).toBe('');
  });
});

/** The pinned `uses:` line of an action in this repo's CI, as written there. */
function ciPin(action: string): string {
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const line = ci.split(/\r?\n/).find((text) => text.includes(`uses: ${action}@`));
  if (line === undefined) throw new Error(`ci.yml has no ${action}`);
  return line.trim().replace(/^- /, '');
}

describe('workflowText: the workflow init writes', () => {
  it("is exploration 06 §5.1 with the spec's rules: npm, a build, .nvmrc", () => {
    const text = workflowText({
      version: '1.2.3',
      build: { manager: 'npm', install: 'npm ci', run: 'npm run build' },
      nodeVersionFile: '.nvmrc',
      fromRepoRoot: '',
    });
    expect(text).toBe(
      [
        '# Deploys with sealup on every push to main (written by sealup init).',
        `# Secrets go through env:, never as inputs: sealup.yml reads them as $\{NAME}.`,
        'name: Deploy',
        '',
        'on:',
        '  push:',
        '    branches: [main]',
        '',
        'permissions:',
        '  contents: read',
        '',
        '# One deploy at a time: a newer push waits, and a running deploy is never cancelled.',
        'concurrency:',
        '  group: sealup-production',
        '  cancel-in-progress: false',
        '',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    environment:',
        '      name: production',
        `      url: $\{{ steps.sealup.outputs.url }}`,
        '    steps:',
        `      - ${ciPin('actions/checkout')}`,
        '        with:',
        '          persist-credentials: false',
        '',
        `      - ${ciPin('actions/setup-node')}`,
        '        with:',
        '          node-version-file: .nvmrc',
        '',
        '      - name: Build',
        '        run: npm ci && npm run build',
        '',
        "      # Pin this step to v1.2.3's full commit SHA (on its release page), as the",
        '      # steps above are: a tag can move, a commit cannot.',
        '      - uses: sealup/sealup@v1.2.3',
        '        id: sealup',
        '        env:',
        `          SEALUP_PASSWORD: $\{{ secrets.SEALUP_PASSWORD }}`,
        '',
      ].join('\n'),
    );
  });

  // Spec #41 decision 38: the public release build puts the release commit's SHA in the bundle.
  it('pins the sealup step to the release commit with its tag in a comment, when it has the SHA', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const text = workflowText({ version: '1.2.3', releaseSha: sha, fromRepoRoot: '' });
    expect(text).toContain(
      '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n\n' +
        '      - uses: sealup/sealup@0123456789abcdef0123456789abcdef01234567 # v1.2.3\n        id: sealup\n',
    );
    expect(text).not.toContain('Pin this step');
  });

  it("pins checkout and setup-node to the SHAs of this repo's CI", () => {
    const text = workflowText({
      version: '1.2.3',
      build: { manager: 'npm', install: 'npm ci', run: 'npm run build' },
      fromRepoRoot: '',
    });
    expect(text).toContain(ciPin('actions/checkout'));
    expect(text).toContain(ciPin('actions/setup-node'));
    expect(text).toContain('          node-version: 24\n');
  });

  it('has no Node and no build step when there is no build', () => {
    const text = workflowText({ version: '1.2.3', fromRepoRoot: '' });
    expect(text).not.toContain('setup-node');
    expect(text).not.toContain('Build');
    expect(text).toContain('actions/checkout@');
    expect(text).toContain(
      "\n\n      # Pin this step to v1.2.3's full commit SHA (on its release page), as the\n" +
        '      # steps above are: a tag can move, a commit cannot.\n' +
        '      - uses: sealup/sealup@v1.2.3\n',
    );
  });

  it('runs in the project folder when it is below the repo root', () => {
    const text = workflowText({
      version: '1.2.3',
      build: { manager: 'npm', install: 'npm ci', run: 'npm run build' },
      nodeVersionFile: '.nvmrc',
      fromRepoRoot: 'apps/site',
    });
    expect(text).toContain('          node-version-file: apps/site/.nvmrc\n');
    expect(text).toContain(
      '      - name: Build\n        working-directory: apps/site\n        run: npm ci && npm run build\n',
    );
    expect(text).toContain(
      '        id: sealup\n        with:\n          working-directory: apps/site\n        env:\n',
    );
  });

  it('quotes a project folder YAML would read otherwise', () => {
    const text = workflowText({ version: '1.2.3', fromRepoRoot: 'my site: #1' });
    expect(text).toContain('          working-directory: "my site: #1"\n');
  });
});
