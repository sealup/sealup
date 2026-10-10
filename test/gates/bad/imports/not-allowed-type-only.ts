// Bites: a type-only import counts too (plan may not know transport's types either).
// Placed at: src/plan/type-import.ts
// Expect: not-allowed
import type { Session } from '../transport/index.ts';

export type Used = Session;
