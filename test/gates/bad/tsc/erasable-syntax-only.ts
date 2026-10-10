// Bites: erasableSyntaxOnly, an enum (plain `node` cannot strip it).
// Placed at: src/plan/erasable-syntax-only.ts
// Expect: TS1294
export enum Mode {
  Upload,
  Delete,
}
