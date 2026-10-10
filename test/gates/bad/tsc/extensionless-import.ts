// Bites: module nodenext, a relative import without its extension (plain `node` cannot load it).
// Placed at: src/plan/extensionless-import.ts
// Expect: TS2835
import { identity } from './strict';

export const same = identity;
