// Bites: R5 through a dynamic import, without the node: prefix.
// Placed at: src/execute/dynamic-spawn.ts
// Expect: no-child-process
export const load = () => import('child_process');
