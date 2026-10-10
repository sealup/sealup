// The bundle's entry point (scripts/build.ts): wires the real process and the real transport into
// main(). Ctrl-C (SIGINT, and SIGTERM as CI runners send on cancel) aborts the run's signal: no
// new transfer starts, the ones in flight finish, what arrived is recorded, exit 130. A second
// Ctrl-C stops at once, also with 130.

//
// The keyboard is stdin in raw mode, only while a question waits (main asks only when stdin and
// stderr are both terminals); between questions stdin is paused, so it never keeps the process
// alive, and Ctrl-C is a signal again.

import { ExitCode } from '../contracts/index.ts';
import { connect, scanCertificate, scanHostKey } from '../transport/index.ts';
import { type Keyboard, main, readVersion } from './index.ts';

/**
 * The release commit's full SHA: put in by the public release build (scripts/build.ts
 * `--release-sha`, spec #41 decision 38); unset in any other build and from source.
 */
declare const SEALUP_RELEASE_SHA: string | undefined;

const releaseSha = typeof SEALUP_RELEASE_SHA === 'string' ? SEALUP_RELEASE_SHA : undefined;
/** From the package.json beside the bundle, `dist/cli.mjs` (spec #41 decision 34). */
const version = readVersion(new URL('../package.json', import.meta.url));

function keyboard(stdin: NodeJS.ReadStream): Keyboard {
  const chunks: string[] = [];
  let waiting: ((chunk: string | undefined) => void) | undefined;
  let ended = false;
  const deliver = (chunk: string | undefined): void => {
    const reader = waiting;
    waiting = undefined;
    if (reader !== undefined) reader(chunk);
    else if (chunk !== undefined) chunks.push(chunk);
  };
  const onData = (data: string | Buffer): void => deliver(String(data));
  const onEnd = (): void => {
    ended = true;
    deliver(undefined);
  };
  return {
    open() {
      stdin.setRawMode?.(true);
      // Whole characters: a key split over two reads is joined first.
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.resume();
    },
    read() {
      const next = chunks.shift();
      if (next !== undefined || ended) return Promise.resolve(next);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.pause();
      stdin.setRawMode?.(false);
      deliver(undefined);
    },
  };
}

const interrupt = new AbortController();
const onSignal = (): void => {
  if (interrupt.signal.aborted) process.exit(ExitCode.interrupted);
  interrupt.abort();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

process.exitCode = await main(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTTY: process.stdout.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  stdin: keyboard(process.stdin),
  stdinIsTTY: process.stdin.isTTY === true,
  cwd: process.cwd(),
  platform: process.platform,
  clock: () => performance.now(),
  connect,
  scanHostKey,
  scanCertificate,
  signal: interrupt.signal,
  ...(version === undefined ? {} : { version }),
  ...(releaseSha === undefined ? {} : { releaseSha }),
});
process.off('SIGINT', onSignal);
process.off('SIGTERM', onSignal);
