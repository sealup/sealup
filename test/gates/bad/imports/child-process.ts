// Bites: R5, no child processes anywhere in src/ (transport is not pure; only R5 stops this).
// Placed at: src/transport/spawns.ts
// Expect: no-child-process
import { spawn } from 'node:child_process';

export const used = spawn;
