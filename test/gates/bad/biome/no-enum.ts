// Bites: noEnum; use a union of string literals (an enum is not erasable syntax).
// Placed at: src/plan/no-enum.ts
// Expect: lint/style/noEnum
export enum Op {
  Upload = 'upload',
  Delete = 'delete',
}
