// Bites: a module imports an npm package that is not on its list (yaml belongs to config).
// Placed at: src/plan/uses-yaml.ts
// Expect: package-not-allowed
import { parse } from 'yaml';

export const used = parse;
