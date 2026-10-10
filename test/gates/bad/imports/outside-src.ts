// Bites: product code imports a file outside src/ (here a dev script).
// Placed at: src/cli/uses-script.ts
// Expect: outside-src
import { gateNames } from '../../scripts/gates.ts';

export const used = gateNames;
