// FTP destinations can have stricter mode rules than the login folder. After the plan's link
// checks, prove each planned write with public bytes under a disposable sibling name, before
// application uploads. Any folders made for this check are removed again; dry runs skip it.

import { randomBytes } from 'node:crypto';
import {
  type Manifest,
  type Plan,
  type Problem,
  type SecretFile,
  type ServerPath,
  type Session,
  type Target,
  TransportError,
} from '../contracts/index.ts';
import type { ManifestStore } from '../manifest/index.ts';
import { foldersToMake, joinServer, parseServerPath, tempPathFor, under } from '../paths/index.ts';

export function refusedModeProblem(target: Target, file: SecretFile): Problem {
  return {
    code: 'secret-file-public',
    path: under(target.server.folder, file.path),
    folder: target.server.folder,
    place: file.place,
    target: target.name,
    reason: 'mode-refused',
  };
}

export async function refusedWriteMode(
  session: Session,
  root: ServerPath,
  plan: Plan,
  writes: readonly SecretFile[],
  store: ManifestStore,
  before: Manifest | undefined,
): Promise<SecretFile | undefined> {
  for (const op of plan.ops) {
    if (op.op !== 'write') continue;
    const file = writes.find((entry) => entry.path === op.path);
    if (file === undefined) throw new RangeError(`planned write not in target: ${op.path}`);
    const relative = tempPathFor(file.path, randomBytes(8).toString('hex'));
    const temp = joinServer(root, relative);
    const parsed = parseServerPath(temp.slice(0, temp.lastIndexOf('/')) || '/');
    if (!parsed.ok) throw new RangeError('invalid probe parent');
    const parent = parsed.path;
    const created: ServerPath[] = [];
    // Persist ownership before the probe starts, so a lost connection leaves a name the next
    // run can clean (R18). Restore the original manifest once the probe has been removed.
    await store.write({
      format: 2,
      folder: root,
      files: before?.files ?? new Map(),
      pending: [...(before?.pending ?? []), relative],
    });
    try {
      const folders = [...foldersToMake(session.loginFolder, root), ...foldersToMake(root, parent)];
      for (const folder of folders) {
        // The configured target and its ancestors may deliberately be links (R16). mkdir
        // follows those as execution already does; checks remain below the target folder.
        if (folder === root || !folder.startsWith(root === '/' ? '/' : `${root}/`)) {
          if (await session.mkdir(folder)) created.push(folder);
          continue;
        }
        const { kind } = await session.stat(folder);
        if (kind === 'not-found') {
          if (await session.mkdir(folder)) created.push(folder);
        } else if (kind !== 'folder') {
          throw new TransportError('protocol', 'in-the-way', { path: folder });
        }
      }
      await session.put({ bytes: Buffer.from('sealup mode probe') }, temp, { mode: file.mode });
    } catch (error) {
      if (error instanceof TransportError && error.reason === 'mode-refused') return file;
      throw error;
    } finally {
      await session.remove(temp);
      for (const folder of created.reverse()) await session.rmdir(folder);
      if (before === undefined) await session.remove(joinServer(store.folder, store.name));
      else await store.write(before);
    }
  }
  return undefined;
}
