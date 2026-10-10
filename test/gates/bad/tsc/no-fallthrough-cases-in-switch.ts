// Bites: noFallthroughCasesInSwitch, a case that falls into the next one.
// Placed at: src/plan/no-fallthrough-cases-in-switch.ts
// Expect: TS7029
export function count(kind: 'a' | 'b'): number {
  let n = 0;
  switch (kind) {
    case 'a':
      n += 1;
    case 'b':
      n += 2;
      break;
  }
  return n;
}
