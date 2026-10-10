// Bites: noUnusedVariables.
// Placed at: src/plan/no-unused-variables.ts
// Expect: lint/correctness/noUnusedVariables
export function twice(value: number): number {
  const forgotten = value + 1;
  return value * 2;
}
