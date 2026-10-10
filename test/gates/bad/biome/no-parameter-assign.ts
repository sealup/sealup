// Bites: noParameterAssign.
// Placed at: src/plan/no-parameter-assign.ts
// Expect: lint/style/noParameterAssign
export function clamp(value: number): number {
  if (value < 0) {
    value = 0;
  }
  return value;
}
