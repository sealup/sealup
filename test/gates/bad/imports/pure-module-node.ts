// Bites: a pure module (plan) imports a Node built-in.
// Placed at: src/plan/uses-fs.ts
// Expect: pure-no-node
import { readFileSync } from 'node:fs';

export const used = readFileSync;
