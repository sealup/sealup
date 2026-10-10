// Bites: noSkippedTests, a `.skip` that hides a failing test.
// Placed at: test/unit/skipped.test.ts
// Expect: lint/suspicious/noSkippedTests
import { expect, it } from 'vitest';

it.skip('never runs', () => {
  expect(1).toBe(2);
});
