// Bites: a ServerPath made by a cast outside paths skips its checks (R10, code review of #14).
// Placed at: src/execute/temp-path.ts
// Expect: brand-cast
import type { ServerPath } from '../contracts/index.ts';

export const temp = `${'/home/site'}/.x.tmp` as ServerPath;
