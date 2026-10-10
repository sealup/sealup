// A clock for tests: the times a run reads are fixed, so durations in the output are exact.

/**
 * A clock (ms) that returns `times` one per reading, then the last one forever. With
 * `steppedClock(0, 15_600)` the first reading is the start and every later one is 15.6 s on, so a
 * run lasts exactly 15.6 s however often it reads the clock.
 */
export function steppedClock(...times: readonly number[]): () => number {
  if (times.length === 0) throw new RangeError('steppedClock needs at least one time');
  let reading = 0;
  return () => {
    const time = times[Math.min(reading, times.length - 1)] ?? 0;
    reading++;
    return time;
  };
}
