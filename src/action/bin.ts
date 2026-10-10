// The action bundle's entry point (`dist/action.mjs`, scripts/build.ts; action.yml's `main`):
// wires the real process and the real transport into runAction(). The runner cancels a step with
// SIGINT, then SIGTERM: the first aborts the run's signal as the CLI does (exit 130), a second
// stops at once.

import { readVersion } from '../cli/index.ts';
import { ExitCode } from '../contracts/index.ts';
import { connect } from '../transport/index.ts';
import { runAction } from './index.ts';

/**
 * From the package.json beside the bundle, `dist/action.mjs`, in the action's checkout (spec #41
 * decision 34): the committed bundle carries no version.
 */
const version = readVersion(new URL('../package.json', import.meta.url));

const interrupt = new AbortController();
const onSignal = (): void => {
  if (interrupt.signal.aborted) process.exit(ExitCode.interrupted);
  interrupt.abort();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

process.exitCode = await runAction(process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
  stderrIsTTY: process.stderr.isTTY === true,
  platform: process.platform,
  clock: () => performance.now(),
  connect,
  signal: interrupt.signal,
  ...(version === undefined ? {} : { version }),
});
process.off('SIGINT', onSignal);
process.off('SIGTERM', onSignal);
