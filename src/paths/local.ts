// The path rule's local side (R10): whether a local path, or a path written in a sam-sync file,
// stays inside its folder. Segment by segment, so a name such as `..x` is a name, never a climb.
// Pure: the caller computes what needs the disk (`path.relative`, a real path) and passes text.

import type { Platform } from './index.ts';

const controlCharacter = /\p{Cc}/u;

/**
 * A `/`-separated path with its `.`, `..` and empty segments resolved and no last `/`, as
 * `path.posix.normalize` reads it: absolute when it starts with `/` (a `..` at the root stays
 * there), `''` for a relative path that is its own start. Undefined when a relative path climbs
 * above its start.
 */
export function normalizePath(path: string): string | undefined {
  const absolute = path.startsWith('/');
  const kept: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') kept.push(segment);
    else if (kept.length > 0) kept.pop();
    else if (!absolute) return undefined;
  }
  return absolute ? `/${kept.join('/')}` : kept.join('/');
}

/**
 * Whether a path relative to a folder, as `path.relative` gives it on `platform`, is that folder
 * or inside it: not absolute (another drive on Windows), and no first `..` segment.
 */
export function staysInside(relative: string, platform: Platform): boolean {
  const slashed = platform === 'win32' ? relative.replaceAll('\\', '/') : relative;
  if (slashed.startsWith('/') || (platform === 'win32' && /^[A-Za-z]:/.test(slashed))) {
    return false;
  }
  return slashed.split('/')[0] !== '..';
}

/**
 * A folder inside the current one as a person types it (`./dist/`, `build\out`): `/`-separated,
 * without `.` segments or a last `/`. Undefined for an empty answer, an absolute path, a `..`
 * segment (even one that would come back inside) or a control character.
 */
export function folderInside(typed: string): string | undefined {
  const text = typed.trim().replaceAll('\\', '/');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || controlCharacter.test(text)) {
    return undefined;
  }
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return undefined;
  return parts.join('/');
}
