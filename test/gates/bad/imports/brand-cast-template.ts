// Bites: a cast hidden in a template literal's ${…} is still code, so still a cast.
// Placed at: src/execute/label.ts
// Expect: brand-cast
import type { ServerPath } from '../contracts/index.ts';

export const label = (p: string): string => `to ${p as ServerPath}`;
