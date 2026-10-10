// Bites: noFocusedTests, an `.only` that would silently skip every other test.
// Placed at: test/unit/focused.test.ts
// Expect: lint/suspicious/noFocusedTests
import { expect, it } from 'vitest';

it.only('runs alone', () => {
  expect(1).toBe(1);
});
