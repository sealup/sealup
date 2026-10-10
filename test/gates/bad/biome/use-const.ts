// Bites: useConst, a `let` that is never reassigned.
// Placed at: src/plan/use-const.ts
// Expect: lint/style/useConst
export function twice(value: number): number {
  let result = value * 2;
  return result;
}
