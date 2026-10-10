// Bites: noNonNullAssertion, a `!` that silences noUncheckedIndexedAccess.
// Placed at: src/plan/no-non-null-assertion.ts
// Expect: lint/style/noNonNullAssertion
export function first(values: readonly number[]): number {
  return values[0]!;
}
