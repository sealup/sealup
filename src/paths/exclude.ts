// `exclude` patterns (decision 0022): .gitignore patterns, written on the local side, relative to
// the folder that holds sealup.yml. A small matcher of our own (ruling 13 allows it): the rules of
// git-scm.com/docs/gitignore "PATTERN FORMAT" that a list in YAML can use. Pure: no node: import.
//
// Kept: `*`, `?`, `[…]` and `[!…]` within one segment; `**` leading, trailing and in the middle; a
// slash at the start or in the middle anchors to the config folder, otherwise the pattern matches
// a name at any depth; a trailing slash matches folders only; `!` re-includes, the last match wins;
// a file inside an excluded folder cannot be re-included (as in git); a backslash escapes; blank
// patterns and `#` comments match nothing; trailing spaces are dropped.

interface Rule {
  readonly regex: RegExp;
  readonly negate: boolean;
  readonly folderOnly: boolean;
}

/**
 * A test for one file, or with `folder` one folder: `path` is `/`-separated and relative to the
 * config folder (it starts with `../` for a source folder outside it, which only unanchored
 * patterns can then reach).
 */
export function excludeMatcher(
  patterns: readonly string[],
): (path: string, folder?: boolean) => boolean {
  const rules = patterns.flatMap((pattern) => {
    const rule = compile(pattern);
    return rule === undefined ? [] : [rule];
  });
  if (rules.length === 0) return () => false;

  const matches = (path: string, folder: boolean): boolean => {
    let excluded = false;
    for (const rule of rules) {
      if (rule.folderOnly && !folder) continue;
      if (rule.regex.test(path)) excluded = !rule.negate;
    }
    return excluded;
  };

  return (path, folder = false) => {
    const segments = path.split('/');
    // Each folder above the file first: an excluded folder excludes all it holds, for good.
    for (let end = 1; end < segments.length; end++) {
      if (matches(segments.slice(0, end).join('/'), true)) return true;
    }
    return matches(path, folder);
  };
}

function compile(raw: string): Rule | undefined {
  let pattern = raw.replace(/(?<!\\) +$/, '');
  if (pattern === '' || pattern.startsWith('#')) return undefined;
  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1);
  const folderOnly = pattern.endsWith('/') && !pattern.endsWith('\\/');
  if (folderOnly) pattern = pattern.slice(0, -1);
  if (pattern === '') return undefined;

  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  let body = '';
  let i = 0;
  if (pattern.startsWith('**/')) {
    body = '(?:.*/)?';
    i = 3;
  }
  while (i < pattern.length) {
    const c = pattern[i] ?? '';
    if (pattern.startsWith('/**/', i)) {
      body += '/(?:.*/)?';
      i += 4;
    } else if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
      body += '/.*';
      i += 3;
    } else if (c === '*') {
      while (pattern[i] === '*') i++;
      body += '[^/]*';
    } else if (c === '?') {
      body += '[^/]';
      i++;
    } else if (c === '[') {
      const end = classEnd(pattern, i);
      if (end === undefined) {
        body += '\\[';
        i++;
      } else {
        body += characterClass(pattern.slice(i + 1, end));
        i = end + 1;
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      body += literal(pattern[i + 1] ?? '');
      i += 2;
    } else {
      body += literal(c);
      i++;
    }
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { regex: new RegExp(`${prefix}${body}$`, 'u'), negate, folderOnly };
}

/** The index of the `]` that closes the class opened at `start`, if any. */
function classEnd(pattern: string, start: number): number | undefined {
  let i = start + 1;
  if (pattern[i] === '!' || pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;
  const end = pattern.indexOf(']', i);
  return end === -1 ? undefined : end;
}

function characterClass(inside: string): string {
  const negated = inside.startsWith('!') || inside.startsWith('^');
  const members = (negated ? inside.slice(1) : inside).replace(/[\\\]^[]/g, (c) => `\\${c}`);
  // A class never matches the separator, like `*` and `?`.
  return negated ? `[^/${members}]` : `(?!/)[${members}]`;
}

function literal(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, (m) => `\\${m}`);
}
