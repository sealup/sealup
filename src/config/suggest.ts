// Did-you-mean for a target name typed on the command line: the name in the file it most likely
// meant. Text only.

/**
 * The name `typed` most likely meant: one it starts (`prod` → `production`), or one at most two
 * edits away (a third of the length for short names). Ties go to the first in the file.
 */
export function closestTargetName(typed: string, names: readonly string[]): string | undefined {
  const lower = typed.toLowerCase();
  const prefixed = names.filter((name) => name.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return prefixed[0];
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = editDistance(lower, name.toLowerCase());
    if (distance <= Math.min(2, Math.floor(name.length / 3)) && distance < (best?.distance ?? 3)) {
      best = { name, distance };
    }
  }
  return best?.name;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
