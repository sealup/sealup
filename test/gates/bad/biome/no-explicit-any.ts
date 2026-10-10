// Bites: noExplicitAny.
// Placed at: src/plan/no-explicit-any.ts
// Expect: lint/suspicious/noExplicitAny
export function first(values: any): unknown {
  return values;
}
