// The bundle budgets (decisions 0011 and 0028), so a cold `npx sealup` stays fast:
//   size        ≤ 760 kB minified (decision 0028; 0011 said 600 kB)
//   gzip        ≤ 230 kB (decision 0028; 0011 said 170 kB)
//   --version   exit code 0, and sealup's own start cost ≤ 150 ms: the median `--version` time
//               minus the median time of a bare `node` (`node --input-type=module --eval ''`),
//               timed the same way in the same job (one warm-up run each, then five runs of each,
//               taken in turns). 0011's 200 ms meant a bare node at about 50 ms; subtracting the
//               bare node keeps a slow runner from failing a cost that is not sealup's
//               (decision 0026, point 6).
//
//   node scripts/budget.ts [bundle]   default: dist/cli.mjs (build it first: npm run build)
//
// The action's bundle (`action.mjs` beside it) gets an `info` line with its sizes: no budget.
//
// kB here is 1,000 bytes. Exit 0 when every budget holds, 1 otherwise, one line per budget.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { repoRoot } from './gates.ts';

const maxBytes = 760_000;
const maxGzipBytes = 230_000;
const maxOwnStartMs = 150;
const timedRuns = 5;

interface Line {
  readonly ok: boolean;
  readonly label: string;
  readonly text: string;
}

const kB = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;

const versionArgs = (bundle: string): string[] => [bundle, '--version'];
const bareNodeArgs = ['--input-type=module', '--eval', ''];

function timeNode(
  args: readonly string[],
): Promise<{ ms: number; exitCode: number; stderr: string }> {
  const started = performance.now();
  return new Promise((done) => {
    execFile(process.execPath, args, { timeout: 10_000 }, (error, _out, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      done({ ms: performance.now() - started, exitCode, stderr: stderr.trim() });
    });
  });
}

/** The middle time of an odd count (a sorted copy: `times` stays in the order it was taken). */
const median = (times: readonly number[]): number =>
  [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? Number.NaN;

async function versionLine(bundle: string): Promise<Line> {
  const label = '--version';
  const warmUp = await timeNode(versionArgs(bundle));
  if (warmUp.exitCode !== 0) {
    return { ok: false, label, text: `exit code ${warmUp.exitCode}: ${warmUp.stderr}` };
  }
  await timeNode(bareNodeArgs);
  const version: number[] = [];
  const bare: number[] = [];
  for (let i = 0; i < timedRuns; i++) {
    version.push((await timeNode(versionArgs(bundle))).ms);
    bare.push((await timeNode(bareNodeArgs)).ms);
  }
  const versionMs = Math.round(median(version));
  const bareMs = Math.round(median(bare));
  const ownMs = versionMs - bareMs;
  const ok = ownMs <= maxOwnStartMs;
  return {
    ok,
    label,
    text:
      `${versionMs} ms, bare node ${bareMs} ms, ` +
      `difference ${ownMs} ms ${ok ? '≤' : '>'} ${maxOwnStartMs} ms`,
  };
}

function sizeLine(label: string, bytes: number, max: number): Line {
  const ok = bytes <= max;
  return { ok, label, text: `${kB(bytes)} ${ok ? '≤' : '>'} ${kB(max)}` };
}

const bundle = resolve(process.argv[2] ?? join(repoRoot, 'dist', 'cli.mjs'));
const content = readFileSync(bundle);
const lines = [
  sizeLine('size', content.length, maxBytes),
  sizeLine('gzip', gzipSync(content).length, maxGzipBytes),
  await versionLine(bundle),
];
for (const line of lines) {
  console.log(`${line.ok ? 'ok    ' : 'FAILED'} ${line.label} ${line.text}`);
}
// The action's bundle, built beside it: its size is printed, under no budget (spec #24
// decision 35; 0011's budgets are the CLI bundle's).
const action = join(dirname(bundle), 'action.mjs');
if (existsSync(action)) {
  const bytes = readFileSync(action);
  console.log(
    `info   action.mjs ${kB(bytes.length)}, gzip ${kB(gzipSync(bytes).length)} (no budget)`,
  );
}
process.exitCode = lines.every((line) => line.ok) ? 0 : 1;
