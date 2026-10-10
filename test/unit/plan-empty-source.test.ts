// plan()'s empty-source net (R20; spec #24 decision 23), pure: table tests. Moved out of
// plan.test.ts, which passed 800 lines; its property test of the net stays there.

import { describe, expect, it } from 'vitest';
import type {
  AllowedRisk,
  EmptySource,
  FileRecord,
  LocalFile,
  Mapping,
  PlanInput,
  RemotePath,
  ServerPath,
  Sha256,
} from '../../src/contracts/index.ts';
import { plan } from '../../src/plan/index.ts';

const hashA = 'a'.repeat(64) as Sha256;
const hashB = 'b'.repeat(64) as Sha256;

/** `upload: { <local>: <remote> }`, a folder next to sealup.yml. */
function folderMapping(local: string, remote: string): Mapping {
  return {
    kind: 'folder',
    local: `/project/${local}`,
    remote: remote === '' ? '' : (remote as RemotePath),
    localFromConfig: local,
    place: { file: '/project/sealup.yml', keyPath: `upload.${local}` },
  };
}

/** `upload: dist`: the dist/ folder goes to the target folder itself. */
const dist = folderMapping('dist', '');
const api = folderMapping('api', 'api');

/** Each file has size 1. */
type Files = Readonly<Record<string, Sha256>>;

function input(
  localFiles: Files,
  recorded: Files | undefined,
  options: {
    uploads?: readonly Mapping[];
    emptySources?: readonly EmptySource[];
    allow?: readonly AllowedRisk[];
  } = {},
): PlanInput {
  const records = new Map<RemotePath, FileRecord>(
    Object.entries(recorded ?? {}).map(([path, sha256]) => [
      path as RemotePath,
      { size: 1, sha256 },
    ]),
  );
  return {
    local: new Map<RemotePath, LocalFile>(
      Object.entries(localFiles).map(([path, sha256]) => [
        path as RemotePath,
        { abs: `/project/dist/${path}`, size: 1, sha256 },
      ]),
    ),
    remote:
      recorded === undefined
        ? { kind: 'absent' }
        : {
            kind: 'found',
            manifest: {
              format: 2,
              folder: '/home/site' as ServerPath,
              files: records,
              pending: [],
            },
          },
    uploads: options.uploads ?? [dist],
    exclude: [],
    emptySources: options.emptySources ?? [],
    allow: new Set(options.allow ?? []),
  };
}

describe('plan: the empty-source net blocks it (R20)', () => {
  it('is blocked by the first source folder that is missing or sends nothing', () => {
    const result = plan(
      input(
        { 'index.html': hashA },
        { 'index.html': hashA, 'api/a.php': hashB },
        { uploads: [dist, api], emptySources: [{ mapping: api, missing: true }] },
      ),
    );
    expect(result.blocked).toEqual({
      reason: 'empty-source',
      source: { mapping: api, missing: true },
    });
  });

  it('is not blocked when the target allows an empty source', () => {
    const result = plan(
      input(
        {},
        { 'index.html': hashA },
        { emptySources: [{ mapping: dist, missing: false }], allow: ['empty-source'] },
      ),
    );
    expect(result.blocked).toBeUndefined();
    expect(result.ops).toEqual([{ op: 'delete', path: 'index.html', reason: 'left-build' }]);
  });

  // A local path that is not there is never planned as a source that sends nothing: no server
  // file of an entry still in the config is deleted because its local side is missing.
  it('is blocked by a missing source even when the target allows an empty one', () => {
    const result = plan(
      input(
        { 'index.html': hashA },
        { 'index.html': hashA, 'api/a.php': hashB },
        {
          uploads: [dist, api],
          emptySources: [
            { mapping: dist, missing: false },
            { mapping: api, missing: true },
          ],
          allow: ['empty-source'],
        },
      ),
    );
    expect(result.blocked).toEqual({
      reason: 'empty-source',
      source: { mapping: api, missing: true },
    });
  });

  it('is not blocked when every source sends a file', () => {
    expect(plan(input({ 'index.html': hashA }, undefined)).blocked).toBeUndefined();
  });
});
