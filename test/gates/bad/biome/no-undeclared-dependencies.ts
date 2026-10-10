// Bites: noUndeclaredDependencies, a package that is not in package.json.
// Placed at: src/config/no-undeclared-dependencies.ts
// Expect: lint/correctness/noUndeclaredDependencies
import { parse } from 'left-pad-undeclared';

export const read = parse;
