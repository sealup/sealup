// Bites: strict (noImplicitAny), a parameter without a type.
// Placed at: src/plan/strict.ts
// Expect: TS7006
export function identity(value) {
  return value;
}
