// Bites: a pure file inside a module that is not pure as a whole (the manifest codec).
// Placed at: src/manifest/codec.ts
// Expect: pure-no-node
import { gzipSync } from 'node:zlib';

export const used = gzipSync;
