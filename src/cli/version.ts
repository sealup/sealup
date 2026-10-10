// sealup's version, read at start-up from the package.json beside the bundle (spec #41 decision
// 34): `dist/cli.mjs` and `dist/action.mjs` both find it at `../package.json`, in the npm
// package and in the action's checkout alike. The bundles carry no version, so a release PR that
// bumps it changes no committed bundle (check-dist stays green).

import { readFileSync } from 'node:fs';

/**
 * The `version` of the package.json at `file`, or undefined when there is none to read (run
 * from source: main() then says `0.0.0-source`).
 */
export function readVersion(file: URL): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const { version } = JSON.parse(text) as { version?: unknown };
    return typeof version === 'string' && version !== '' ? version : undefined;
  } catch {
    return undefined;
  }
}
