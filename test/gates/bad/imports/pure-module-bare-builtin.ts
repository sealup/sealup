// Bites: a pure module (paths) imports a Node built-in without the node: prefix.
// Placed at: src/paths/bare-builtin.ts
// Expect: pure-no-node
import { sep } from 'path';

export const used = sep;
