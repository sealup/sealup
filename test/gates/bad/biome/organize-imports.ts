// Bites: the organizeImports assist, imports out of order.
// Placed at: src/scan/organize-imports.ts
// Expect: assist/source/organizeImports
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export const both = [join, readFileSync];
