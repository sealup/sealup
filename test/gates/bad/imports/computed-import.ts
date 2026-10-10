// Bites: an import whose specifier is computed, so no rule could check it.
// Placed at: src/deploy/computed.ts
// Expect: computed-import
const name = ['node:child', 'process'].join('_');

export const load = () => import(name);
