// R14 (decision 0038, ruling 9 of plan 02): where the manifest folder may be. Not any mapping's
// server folder nor inside one: those are the folders sealup sends files to, where visitors
// could download the manifest. Elsewhere in the target folder it is accepted (the default
// `/~/.sealup` beside `/~/www`); a mapping into the target folder itself makes the whole target
// folder off limits. A single file's own path counts, not its folder.

import type { Problem, Target } from '../contracts/index.ts';
import { inLoginFolder, isWithin, under } from '../paths/index.ts';

/**
 * The Problem of a manifest folder inside a mapping's server folder (exit 2). `targetFolder` and
 * `manifestFolder` in one form: before connecting, as the config writes them (the rule is
 * decided only when both are absolute or both in the login folder); once connected (`loginFolder`
 * given), resolved.
 */
export function manifestInsideTarget(
  manifestFolder: string,
  targetFolder: string,
  target: Target,
  loginFolder?: string,
): Problem | undefined {
  const connected = loginFolder !== undefined;
  if (!connected && inLoginFolder(manifestFolder) !== inLoginFolder(targetFolder)) return undefined;
  for (const mapping of target.uploads) {
    const serverFolder = under(targetFolder, mapping.remote);
    if (!isWithin(manifestFolder, serverFolder)) continue;
    // Before connecting, `/` holds the login folder; `/~` is it.
    const login = loginFolder ?? '/~';
    return {
      code: 'manifest-inside-target',
      manifestFolder,
      targetFolder,
      serverFolder,
      place: mapping.place,
      connected,
      ...(isWithin(login, serverFolder) ? { loginFolderInside: true } : {}),
      target: target.name,
    };
  }
  return undefined;
}
