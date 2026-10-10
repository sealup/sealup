// Bites: noImplicitOverride, a method that overrides without the override keyword.
// Placed at: src/plan/no-implicit-override.ts
// Expect: TS4114
class Base {
  describe(): string {
    return 'base';
  }
}

export class Derived extends Base {
  describe(): string {
    return 'derived';
  }
}
