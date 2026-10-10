// Bites: a test imports a module file other than its entry file.
// Placed at: test/unit/deep-import.test.ts
// Expect: entry-only
import { plan } from '../../src/plan/rules.ts';

export const used = plan;
