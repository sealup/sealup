// Bites: noUncheckedIndexedAccess, an array element used as if it always exists.
// Placed at: src/plan/no-unchecked-indexed-access.ts
// Expect: TS2532
const sizes: number[] = [];

export const first = sizes[0].toFixed(1);
