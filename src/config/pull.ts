// The `pull` entries of a target (decision 0002, spec #24 decision 25, R19): `remote: local`
// pairs for `sealup pull`. The server side is a folder or a file under the target folder (R10;
// `.` is the target folder itself); which of the two, the server says when sealup pulls. The
// local side must stay inside the folder of sealup.yml, and never be that folder itself: a pull
// never writes beside sealup.yml or above it. The local side is filled in like any value; a
// problem stops only a run to this target.

import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ConfigIssue, ConfigPlace, PullEntry, RemotePath } from '../contracts/index.ts';
import { parseRemotePath } from '../paths/index.ts';
import type { PullInput } from './schema.ts';

type Path = readonly (string | number)[];

interface PullContext {
  /** The folder holding the config. */
  readonly folder: string;
  /** The value with its variables filled in, or undefined after reporting the unset one. */
  readonly fill: (text: string, path: Path) => string | undefined;
  readonly place: (path: Path) => ConfigPlace;
}

/** One target's pull entries, the shared list first; issues go to `issues`. */
export function resolvePulls(
  lists: readonly (readonly [pull: PullInput, path: Path])[],
  issues: ConfigIssue[],
  context: PullContext,
): PullEntry[] {
  const entries: PullEntry[] = [];
  for (const [pull, at] of lists) {
    for (const [remoteText, localText] of Object.entries(pull)) {
      const path = [...at, remoteText];
      const place = context.place(path);
      // A key is never filled in (as `upload`'s local side): only the value is.
      const local = context.fill(localText, path);
      if (local === undefined) continue;
      const remote = serverSide(remoteText);
      if (remote === undefined) {
        issues.push({ code: 'remote-path', ...place, detail: 'pull' });
        continue;
      }
      const inside = localSide(context.folder, local);
      if (inside === undefined) {
        issues.push({ code: 'bad-path', ...place, detail: 'pull' });
        continue;
      }
      entries.push({ remote, ...inside, place });
    }
  }
  return entries;
}

/** A folder or file under the target folder (R10); `.` or nothing is the target folder. */
function serverSide(text: string): RemotePath | '' | undefined {
  if (text === '' || text === '.') return '';
  const parsed = parseRemotePath(text);
  return parsed.ok ? parsed.path : undefined;
}

/** The local side, absolute and from the config folder, when it is strictly inside that folder. */
function localSide(
  folder: string,
  text: string,
): Pick<PullEntry, 'local' | 'localFromConfig'> | undefined {
  if (text === '' || /\p{Cc}/u.test(text) || isAbsolute(text) || text.startsWith('/')) {
    return undefined;
  }
  const local = resolve(folder, text);
  const fromConfig = relative(folder, local);
  if (fromConfig === '' || fromConfig === '..' || fromConfig.startsWith(`..${sep}`)) {
    return undefined;
  }
  if (isAbsolute(fromConfig)) return undefined;
  return { local, localFromConfig: fromConfig.split(sep).join('/') };
}
