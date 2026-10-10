// The leak-test harness (R1), proven to bite: a fixture program leaks a canary secret in one form
// at a time, in stdout, stderr, the JSON object or a file written to the server; the harness
// must name the place and the form. A program that prints only `[secret]` passes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import {
  canaries,
  expectNoLeaks,
  findLeaks,
  readTree,
  splitMasks,
} from '../../src/testkit/index.ts';
import { runCli, runWithCanaries } from '../cli-kit.ts';

const fixture = join(repoRoot, 'test', 'gates', 'bad', 'leak', 'print-canary.ts');

const cases = [
  { place: 'stdout', form: 'raw', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stderr', form: 'raw', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'json', form: 'raw', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'file', form: 'raw', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stderr', form: 'json-escaped', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stderr', form: 'url-encoded', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stderr', form: 'form-encoded', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stdout', form: 'base64', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stdout', form: 'base64url', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'file', form: 'basic-auth', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stderr', form: 'hex', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stderr', form: 'hex-upper', canary: 'SEALUP_CANARY_PASSWORD' },
  { place: 'stdout', form: 'second-line', canary: 'SEALUP_CANARY_MULTILINE' },
  { place: 'stderr', form: 'key-line', canary: 'SEALUP_CANARY_KEY' },
] as const;

/** The form name the harness reports for each fixture form. */
const reported: Record<string, string> = {
  raw: 'raw',
  'json-escaped': 'JSON-escaped',
  'url-encoded': 'URL-encoded',
  'form-encoded': 'form-encoded',
  base64: 'base64',
  base64url: 'base64url',
  'basic-auth': 'base64',
  hex: 'hex',
  'hex-upper': 'hex',
  'second-line': 'line 2, raw',
  'key-line': 'line 3, raw',
};

describe.concurrent('leak harness, proven to bite', () => {
  let server = '';
  beforeAll(() => {
    server = mkdtempSync(join(tmpdir(), 'sealup-leak-'));
  });
  afterAll(() => rmSync(server, { recursive: true, force: true }));

  it.each(cases)('finds $canary in $place, $form', async ({ place, form, canary }) => {
    const file = join(server, `${place}-${form}.txt`);
    const run = await runWithCanaries([fixture, place, form, file], { cwd: server });
    expect(run.exitCode, run.stderr).toBe(0);
    const json = place === 'json' ? (JSON.parse(run.stdout) as unknown) : undefined;
    const files = place === 'file' ? await readTree(server) : {};
    const places = {
      // The JSON object is checked on its own: its text holds the JSON-escaped form.
      stdout: place === 'json' ? '' : run.stdout,
      stderr: run.stderr,
      json,
      ...files,
    };
    const where = place === 'file' ? `${place}-${form}.txt` : place;
    expect(findLeaks(places)).toContainEqual({ place: where, form: reported[form], canary });
    expect(() => expectNoLeaks(places)).toThrow(`${canary} leaked in ${where}`);
  });

  it('runCli fails a run that leaks', async () => {
    await expect(runCli([fixture, 'stderr', 'base64'], { cwd: server })).rejects.toThrow(
      'SEALUP_CANARY_PASSWORD leaked in stderr as base64',
    );
  });

  it('passes a program that prints only [secret]', async () => {
    const run = await runCli([fixture, 'stdout', 'redacted'], { cwd: server });
    expect(run.stdout).toContain('[secret]');
  });

  it('never prints a canary in its own failure message', () => {
    let message = '';
    try {
      expectNoLeaks({ stdout: Object.values(canaries).join(' ') });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('leaked in stdout');
    expect(findLeaks({ message })).toEqual([]);
  });
});

describe("GitHub's mask lines, the one exception (R2, spec #24 decision 30)", () => {
  const password = canaries.SEALUP_CANARY_PASSWORD;
  const encoded = Buffer.from(password).toString('base64');

  it('may hold a canary when they lead the log: the rest is checked alone', () => {
    const log = `::add-mask::${encoded}\nsealup 0.1.0 · deploy\n  ✓ done\n`;
    const { masks, rest } = splitMasks(log);
    expect(findLeaks({ masks })).not.toEqual([]);
    expect(findLeaks({ rest })).toEqual([]);
  });

  it('are not an exception once another line came first', () => {
    const log = `sealup 0.1.0 · deploy\n::add-mask::${encoded}\n`;
    const { masks, rest } = splitMasks(log);
    expect(masks).toBe('');
    expect(findLeaks({ rest })).toContainEqual({
      place: 'rest',
      form: 'base64',
      canary: 'SEALUP_CANARY_PASSWORD',
    });
  });
});

describe('the canaries', () => {
  it('hold the characters that break naive escaping, and a newline', () => {
    const all = Object.values(canaries).join('');
    for (const char of ['"', "'", '$', '/', '+', '=', '%', '\\', '\n']) {
      expect(all).toContain(char);
    }
  });

  it('include one single-line password, which a login can use (R4 refuses newlines)', () => {
    expect(canaries.SEALUP_CANARY_PASSWORD).not.toMatch(/[\r\n\0]/);
  });

  it('include a multi-line private key, which a login can use (decision 0033)', () => {
    const lines = canaries.SEALUP_CANARY_KEY.trimEnd().split('\n');
    expect(lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(lines.length).toBeGreaterThan(3);
  });
});
