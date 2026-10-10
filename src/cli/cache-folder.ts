// Where the user's cache folder for sealup is (spec #41 decision 25): deploy's scan keeps the
// project's hash cache there. Read from the environment main() is given, never from
// process.env, so a test points it at a temp folder.

import { isAbsolute, join } from 'node:path';
import type { Env } from '../config/index.ts';

/**
 * `%LOCALAPPDATA%\sealup` on Windows; elsewhere `$XDG_CACHE_HOME/sealup`, or `~/.cache/sealup`
 * when that is unset or relative (the XDG spec ignores a relative one). Undefined when the
 * environment names no such folder: the deploy then keeps no cache.
 */
export function cacheFolder(env: Env, platform: string): string | undefined {
  const base =
    platform === 'win32'
      ? absolute(env.LOCALAPPDATA)
      : (absolute(env.XDG_CACHE_HOME) ?? withCache(absolute(env.HOME)));
  return base === undefined ? undefined : join(base, 'sealup');
}

function absolute(folder: string | undefined): string | undefined {
  return folder !== undefined && folder !== '' && isAbsolute(folder) ? folder : undefined;
}

function withCache(home: string | undefined): string | undefined {
  return home === undefined ? undefined : join(home, '.cache');
}
