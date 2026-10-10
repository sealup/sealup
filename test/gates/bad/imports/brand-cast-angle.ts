// Bites: the angle-bracket form of a cast to RemotePath, outside paths.
// Placed at: src/plan/angle.ts
// Expect: brand-cast
import type { RemotePath } from '../contracts/index.ts';

export const p = <RemotePath>'a/b';
