// The bundle budgets (decisions 0011 and 0028, start time measured as in spec #15 decision 6), proven to
// bite: an oversized bundle and a slow one, checked by the real script. The start time is
// sealup's own cost, the `--version` median minus a bare `node` median, so a fast bundle passes
// it even while the other tests load the machine. The repo's own bundle is checked in CI
// (`npm run budget`).

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'budget.ts');

describe.concurrent('budget, proven to bite', () => {
  let folder = '';
  const at = (name: string): string => join(folder, name);

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'sealup-budget-'));
    // 800 kB of random base64: over 760 kB minified, and it gzips to about 600 kB.
    const noise = randomBytes(600_000).toString('base64');
    writeFileSync(at('big.mjs'), `console.log('1.0.0');\n// ${noise}\n`);
    writeFileSync(
      at('slow.mjs'),
      "const end = Date.now() + 300; while (Date.now() < end); console.log('1.0.0');\n",
    );
    writeFileSync(at('small.mjs'), "console.log('1.0.0');\n");
    writeFileSync(at('broken.mjs'), "process.stderr.write('boom\\n'); process.exit(3);\n");
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('fails a bundle over 760 kB minified and 230 kB gzip', async () => {
    const run = await runNode([script, at('big.mjs')], folder);
    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(/^FAILED size .* > 760\.0 kB$/m);
    expect(run.output).toMatch(/^FAILED gzip .* > 230\.0 kB$/m);
  });

  it('fails a bundle whose --version costs over 150 ms more than a bare node', async () => {
    const run = await runNode([script, at('slow.mjs')], folder);
    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(
      /^FAILED --version \d+ ms, bare node \d+ ms, difference \d+ ms > 150 ms$/m,
    );
  });

  it('fails a bundle whose --version does not exit 0', async () => {
    const run = await runNode([script, at('broken.mjs')], folder);
    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(/^FAILED --version exit code 3/m);
  });

  it("prints the action bundle's sizes beside the bundle, with no budget (spec #24 decision 35)", async () => {
    const beside = mkdtempSync(join(tmpdir(), 'sealup-budget-action-'));
    try {
      writeFileSync(join(beside, 'cli.mjs'), "console.log('1.0.0');\n");
      // Over both limits: it is printed, and fails nothing.
      writeFileSync(join(beside, 'action.mjs'), randomBytes(525_000).toString('base64'));
      const run = await runNode([script, join(beside, 'cli.mjs')], beside);
      expect(run.output).toMatch(/^info {3}action\.mjs 700\.0 kB, gzip \d+\.\d kB \(no budget\)$/m);
      expect(run.exitCode, run.output).toBe(0);
    } finally {
      rmSync(beside, { recursive: true, force: true });
    }
  });

  it('passes a small, fast bundle, printing both medians and the difference', async () => {
    const run = await runNode([script, at('small.mjs')], folder);
    expect(run.output).toMatch(/^ok {5}size /m);
    expect(run.output).toMatch(/^ok {5}gzip /m);
    expect(run.output).toMatch(
      /^ok {5}--version \d+ ms, bare node \d+ ms, difference -?\d+ ms ≤ 150 ms$/m,
    );
    expect(run.exitCode).toBe(0);
  });
});
