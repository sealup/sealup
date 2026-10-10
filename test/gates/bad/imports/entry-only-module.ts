// Bites: a module reaches past another module's entry file into its internals.
// Placed at: src/deploy/deep-import.ts
// Expect: entry-only
import { plan } from '../plan/rules.ts';

export const used = plan;
