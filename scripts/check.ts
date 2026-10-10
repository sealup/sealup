// Runs the code gates on the repo, in parallel, and prints one line per gate.
//
//   node scripts/check.ts                  every gate (the pre-commit hook)
//   node scripts/check.ts lint typecheck   only the named gates
//
// Gates: typecheck (tsc), lint (Biome), imports (the import rules), knip, test (Vitest unit and
// integration, which holds the proven-to-bite tests). Exit 0 when all pass, 1 otherwise; the
// output of every failed gate is printed in full. Budget: 15 s (decision 0013).

import { gateArgs, gateNames, isGateName, printResults, runStep } from './gates.ts';

/** Runs the named gates (all when none is named); true when every one passed. */
async function check(args: readonly string[]): Promise<boolean> {
  const started = performance.now();
  const selected = args.length === 0 ? gateNames : args.filter(isGateName);
  const results = await Promise.all(selected.map((name) => runStep(name, gateArgs(name))));
  printResults(results, started);
  return results.every((r) => r.ok);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !isGateName(arg));
  if (unknown.length > 0) {
    console.error(`unknown gate: ${unknown.join(', ')} (gates: ${gateNames.join(', ')})`);
    process.exitCode = 2;
  } else {
    process.exitCode = (await check(args)) ? 0 : 1;
  }
}
