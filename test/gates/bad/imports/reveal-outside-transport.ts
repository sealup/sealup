// Bites: only transport reveals a secret (spec #1); report may import secret, but not reveal().
// Placed at: src/report/reveals.ts
// Expect: reveal-only-transport
import { reveal } from '../secret/index.ts';

export const used = reveal;
