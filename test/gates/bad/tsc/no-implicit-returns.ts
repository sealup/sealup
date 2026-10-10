// Bites: noImplicitReturns, a code path that ends without a return.
// Placed at: src/plan/no-implicit-returns.ts
// Expect: TS7030
export function size(known: boolean): number | undefined {
  if (known) {
    return 1;
  }
}
