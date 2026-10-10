// Bites: verbatimModuleSyntax, a type imported without `import type`.
// Placed at: src/plan/verbatim-module-syntax.ts
// Expect: TS1484
import { PathLike } from 'node:fs';

export type Where = PathLike;
