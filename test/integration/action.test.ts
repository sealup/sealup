// The GitHub action's entry (spec #24 decisions 33, 34; 0014, 0024 §11), in process with a fake
// GitHub environment: the runner's inputs as INPUT_* variables, GITHUB_WORKSPACE, GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY and RUNNER_TEMP in a fresh folder. It checks what a workflow sees: the exit
// code, the log, the outputs file, the plan file and the job summary. Every run's places go
// through the leak check, the canary password and the multi-line canary `write` secret in play.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../../scripts/gates.ts';
import { runAction } from '../../src/action/index.ts';
import type { Session } from '../../src/contracts/index.ts';
import {
  canaries,
  createMemoryServer,
  expectNoLeaks,
  splitMasks,
  steppedClock,
} from '../../src/testkit/index.ts';
import {
  createProject,
  productionConfig,
  ref,
  twoTargetConfig,
  versionLine,
} from '../deploy-kit.ts';

const site = { 'public_html/index.html': '<h1>home</h1>' };
/** The page's production target, its password the canary, api/.env written from the multi-line canary. */
const config = `${productionConfig({ password: 'SEALUP_CANARY_PASSWORD' })}write:\n  api/.env: ${ref('SEALUP_CANARY_MULTILINE')}\n`;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Step {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** `$GITHUB_OUTPUT`'s text. */
  readonly outputFile: string;
  /** The outputs, read back from the delimiter form. */
  readonly outputs: Readonly<Record<string, string>>;
  readonly summary: string;
  /** The files in `$RUNNER_TEMP`, by name. */
  readonly temp: Readonly<Record<string, string>>;
  /** `$RUNNER_TEMP` itself. */
  readonly runnerTemp: string;
}

interface StepOptions {
  /** GITHUB_WORKSPACE (absent: unset). */
  readonly workspace: string | undefined;
  readonly server?: { connect(): Promise<Session> };
  readonly env?: Readonly<Record<string, string>>;
}

/** The inputs action.yml declares, with their defaults: the runner sets an INPUT_ for each. */
const defaults: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    (
      parse(readFileSync(join(repoRoot, 'action.yml'), 'utf8')) as {
        inputs: Record<string, { default: string }>;
      }
    ).inputs,
  ).map(([name, input]) => [name, input.default]),
);

/** Reads `name<<delimiter`, the value's lines, `delimiter` (GitHub's multi-line form). */
function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split('\n');
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? '';
    if (line === '' && at === lines.length - 1) break;
    const head = /^([\w-]+)<<(.+)$/.exec(line);
    if (head === null) throw new Error(`not the delimiter form: line ${at + 1}`);
    const [, name = '', delimiter = ''] = head;
    const end = lines.indexOf(delimiter, at + 1);
    if (end === -1) throw new Error(`${name}: no closing delimiter`);
    outputs[name] = lines.slice(at + 1, end).join('\n');
    at = end + 1;
  }
  return outputs;
}

/** Runs the action's entry as the runner would, one step in a fresh runner folder. */
async function runStep(
  inputs: Readonly<Record<string, string>>,
  options: StepOptions,
): Promise<Step> {
  const runner = mkdtempSync(join(tmpdir(), 'sealup runner '));
  folders.push(runner);
  const temp = join(runner, '_temp');
  mkdirSync(temp);
  const outputPath = join(runner, 'output');
  const summaryPath = join(runner, 'step_summary');
  writeFileSync(outputPath, '');
  writeFileSync(summaryPath, '');
  const env: Record<string, string> = {
    ...canaries,
    PROD_PASSWORD: 'pw-for-tests',
    GITHUB_ACTIONS: 'true',
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    RUNNER_TEMP: temp,
    ...(options.workspace === undefined ? {} : { GITHUB_WORKSPACE: options.workspace }),
    ...options.env,
  };
  for (const [name, value] of Object.entries({ ...defaults, ...inputs })) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }
  let stdout = '';
  let stderr = '';
  const exitCode = await runAction(env, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    stderrIsTTY: false,
    platform: 'linux',
    clock: steppedClock(0, 3_140),
    connect: async () => {
      if (options.server === undefined) throw new Error('the test gave the step no server');
      return options.server.connect();
    },
  });
  const outputFile = readFileSync(outputPath, 'utf8');
  const summary = readFileSync(summaryPath, 'utf8');
  const tempFiles = Object.fromEntries(
    readdirSync(temp, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(temp, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')];
      }),
  );
  // GitHub's mask lines are the one place a secret is written (R2); nowhere else.
  expectNoLeaks({
    stdout,
    stderr: splitMasks(stderr).rest,
    outputs: outputFile,
    summary,
    ...Object.fromEntries(Object.entries(tempFiles).map(([name, text]) => [`temp ${name}`, text])),
  });
  return {
    exitCode,
    stdout,
    stderr,
    outputFile,
    outputs: parseOutputs(outputFile),
    summary,
    temp: tempFiles,
    runnerTemp: temp,
  };
}

/** A project in its own workspace folder (a checkout), and a memory server. */
function workspace(files: Readonly<Record<string, string>> = site) {
  const project = createProject(config, files);
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  return { root: project.root, server };
}

describe('the action: inputs to a deploy', () => {
  it('deploys the named target from the workspace, with the outputs of the run', async () => {
    const { root, server } = workspace();

    const step = await runStep({ target: 'production' }, { workspace: root, server });

    expect(step.exitCode).toBe(0);
    expect(step.outputs).toEqual({
      status: 'deployed',
      url: 'https://example.com',
      uploaded: '1',
      deleted: '0',
      unchanged: '0',
      bytes: '13',
      duration: '3.1',
      plan: '',
    });
    expect(server.files().has('/home/site/index.html')).toBe(true);
  });

  it('runs main() as `deploy [target] [--dry-run] [-c <config>]`: its log, masks first, and its job summary', async () => {
    const { root, server } = workspace();
    const step = await runStep(
      { target: 'production', 'dry-run': 'true', config: 'sealup.yml' },
      { workspace: root, server },
    );

    expect(step.exitCode).toBe(0);
    const { masks, rest } = splitMasks(step.stderr);
    expect(masks).not.toBe('');
    expect(rest.split('\n')[0]).toBe(versionLine('deploy', 'production'));
    expect(step.summary).toMatch(/^### 📋 /);
    expect(step.stdout).toBe('');
  });

  it('on a dry run, sets status to dry-run and plan to a file in RUNNER_TEMP holding the --json object', async () => {
    const { root, server } = workspace();

    const step = await runStep(
      { target: 'production', 'dry-run': 'true' },
      { workspace: root, server },
    );

    expect(step.exitCode).toBe(0);
    expect(step.outputs).toMatchObject({ status: 'dry-run', uploaded: '1', bytes: '13' });
    const names = Object.keys(step.temp);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^sealup-plan-[0-9a-f]{8}\.json$/);
    expect(step.outputs.plan).toBe(join(step.runnerTemp, names[0] ?? ''));
    expect(JSON.parse(step.temp[names[0] ?? ''] ?? '')).toMatchObject({
      format: 1,
      command: 'deploy',
      target: 'production',
      dryRun: true,
      status: 'ok',
      written: 1,
      ops: [
        { op: 'upload', path: 'index.html', reason: 'new', size: 13 },
        { op: 'write', path: 'api/.env', reason: 'new', size: null },
      ],
    });
    expect(server.files().has('/home/site/index.html')).toBe(false);
  });

  it('says unchanged on a redeploy with nothing new', async () => {
    const { root, server } = workspace();
    await runStep({ target: 'production' }, { workspace: root, server });

    const step = await runStep({ target: 'production' }, { workspace: root, server });

    expect(step.exitCode).toBe(0);
    expect(step.outputs).toMatchObject({ status: 'unchanged', uploaded: '0', unchanged: '2' });
  });

  it('runs in working-directory, inside the workspace, and reads `config` from there', async () => {
    const { root, server } = workspace();
    const checkout = join(root, '..');
    const folder = relative(checkout, root).replaceAll('\\', '/');

    const found = await runStep({ 'working-directory': folder }, { workspace: checkout, server });
    const named = await runStep(
      { 'working-directory': `./${folder}/`, config: 'sealup.yml' },
      { workspace: checkout, server },
    );

    expect(found.exitCode).toBe(0);
    expect(found.outputs.status).toBe('deployed');
    expect(named.exitCode).toBe(0);
    expect(named.outputs.status).toBe('unchanged');
  });
});

describe('the action: refusals and failures', () => {
  it('stops with exit 2 when working-directory is outside the workspace, before reading anything', async () => {
    const { root } = workspace();
    const inside = join(root, 'public_html');

    const step = await runStep({ 'working-directory': '..' }, { workspace: inside });

    expect(step.exitCode).toBe(2);
    expect(step.stderr).toContain('working-directory .. is outside the workspace');
    expect(step.stderr).toMatch(/^::error /m);
    expect(step.outputs).toMatchObject({ status: 'failed', url: '', uploaded: '0', plan: '' });
    expect(step.summary).toMatch(/^### ❌ /);
  });

  it('stops with exit 2 when working-directory is a link inside the workspace to a folder outside', async () => {
    const { root } = workspace();
    const checkout = mkdtempSync(join(tmpdir(), 'sealup checkout '));
    folders.push(checkout);
    // A junction on Windows (no rights needed), a folder link elsewhere.
    symlinkSync(root, join(checkout, 'site'), 'junction');

    const step = await runStep({ 'working-directory': 'site' }, { workspace: checkout });

    expect(step.exitCode).toBe(2);
    expect(step.stderr).toContain('working-directory site is outside the workspace');
  });

  it('stops with exit 2 when GITHUB_WORKSPACE is not set', async () => {
    const step = await runStep({}, { workspace: undefined });

    expect(step.exitCode).toBe(2);
    expect(step.stderr).toContain('GITHUB_WORKSPACE');
    expect(step.outputs.status).toBe('failed');
  });

  it('stops with exit 2 when dry-run is neither true nor false', async () => {
    const { root } = workspace();

    const step = await runStep({ 'dry-run': 'yes' }, { workspace: root });

    expect(step.exitCode).toBe(2);
    expect(step.stderr).toContain('dry-run takes true or false');
    expect(step.outputs.status).toBe('failed');
  });

  it("reads dry-run as GitHub's booleans do: true, True, TRUE, false, False, FALSE", async () => {
    const { root, server } = workspace();
    for (const value of ['True', 'TRUE']) {
      const step = await runStep(
        { target: 'production', 'dry-run': value },
        { workspace: root, server },
      );
      expect(step.outputs.status).toBe('dry-run');
    }
    const step = await runStep(
      { target: 'production', 'dry-run': 'FALSE' },
      { workspace: root, server },
    );
    expect(step.outputs.status).toBe('deployed');
  });

  it("exits with sealup's code: a missing variable is 2, status failed, the plan file says why", async () => {
    const { root } = workspace();

    const step = await runStep(
      { target: 'production', 'dry-run': 'true' },
      { workspace: root, env: { SEALUP_CANARY_PASSWORD: '' } },
    );

    expect(step.exitCode).toBe(2);
    expect(step.outputs.status).toBe('failed');
    const [plan] = Object.values(step.temp);
    expect(JSON.parse(plan ?? '')).toMatchObject({ dryRun: true, status: 'failed', exitCode: 2 });
  });

  it("keeps sealup's exit code when the outputs file cannot be written, with a warning", async () => {
    const { root, server } = workspace();
    const folder = mkdtempSync(join(tmpdir(), 'sealup not a file '));
    folders.push(folder);

    const step = await runStep(
      { target: 'production' },
      { workspace: root, server, env: { GITHUB_OUTPUT: folder } },
    );

    expect(step.exitCode).toBe(0);
    expect(step.stderr).toMatch(
      /^::warning title=Outputs not written::sealup could not write it \(E\w+\)\.$/m,
    );
  });

  it('runs with both canaries in play, so the leak check on every place can bite', async () => {
    const { root, server } = workspace();

    const step = await runStep(
      { target: 'production', 'dry-run': 'true' },
      { workspace: root, server },
    );

    // The masks are the one place the secrets are written: the password and each line of the
    // multi-line canary reached the run.
    const { masks } = splitMasks(step.stderr);
    expect(masks).toContain('::add-mask::Cn4ry-pw');
    expect(masks).toContain('::add-mask::Cn4ry-second-line-fake');
    expect(Object.keys(step.temp)).toHaveLength(1);
    expect(step.summary).not.toBe('');
  });

  it('never asks: several targets and no target input stop with exit 2, naming the input', async () => {
    const project = createProject(twoTargetConfig(), {
      'www/index.html': '<h1>home</h1>',
      'api/index.php': '<?php',
    });

    const step = await runStep(
      {},
      { workspace: project.root, env: { STAGING_PASSWORD: 'pw-for-staging' } },
    );

    expect(step.exitCode).toBe(2);
    expect(step.stderr).toContain("action's target input");
    expect(step.outputs.status).toBe('failed');
  });

  it('says blocked when a safety net stops the run (exit 6)', async () => {
    const project = createProject(
      `${productionConfig({ password: 'SEALUP_CANARY_PASSWORD' })}write:\n  public_html/.env: ${ref('SEALUP_CANARY_MULTILINE')}\n`,
      site,
    );

    const step = await runStep({ target: 'production' }, { workspace: project.root });

    expect(step.exitCode).toBe(6);
    expect(step.outputs.status).toBe('blocked');
  });
});
