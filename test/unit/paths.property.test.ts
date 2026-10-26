import { posix } from 'node:path';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RemotePath, ServerPath } from '../../src/contracts/index.ts';
import {
  isWithin,
  joinServer,
  localToRemote,
  parseRemotePath,
  parseServerPath,
  remoteToLocal,
  tempNameFor,
  tempPathFor,
} from '../../src/paths/index.ts';
import {
  propertyOptions,
  randomHex,
  remotePathText,
  serverPathText,
  unsafePathText,
} from '../property-kit.ts';

describe('path safety properties (R10, R18)', () => {
  it('keeps every generated file inside its target, without changing its relative name', () => {
    fc.assert(
      fc.property(serverPathText, remotePathText, (folder, name) => {
        const root = parseServerPath(folder);
        const file = parseRemotePath(name);
        if (!root.ok || !file.ok) throw new Error('valid generated path rejected');
        const joined = joinServer(root.path, file.path);
        // node:path is an independent oracle for containment and normalization.
        expect(posix.relative(folder, joined)).toBe(name);
        expect(posix.resolve(folder, name)).toBe(joined);
      }),
      propertyOptions,
    );
  });

  it('rejects generated traversal, aliases, protocol delimiters and non-NFC paths', () => {
    fc.assert(
      fc.property(serverPathText, unsafePathText, (folder, name) => {
        expect(parseRemotePath(name).ok).toBe(false);
        // Recheck even a forged branded value received from an untrusted boundary.
        expect(() => joinServer(folder as ServerPath, name as RemotePath)).toThrow(RangeError);
      }),
      propertyOptions,
    );
  });

  it('round-trips names on both platforms, normalizing decomposed local Unicode', () => {
    fc.assert(
      fc.property(remotePathText, (name) => {
        for (const platform of ['win32', 'posix'] as const) {
          const local = remoteToLocal(name as RemotePath, platform);
          expect(localToRemote(local.normalize('NFD'), platform)).toEqual({ ok: true, path: name });
        }
      }),
      propertyOptions,
    );
  });

  it('does not mistake a sibling with the same prefix for a descendant', () => {
    fc.assert(
      fc.property(remotePathText, (root) => {
        expect(isWithin(`/root/${root}-sibling`, `/root/${root}`)).toBe(false);
        expect(isWithin(`/root/${root}/child`, `/root/${root}`)).toBe(true);
      }),
      propertyOptions,
    );
  });

  it('puts relative and absolute upload temporaries in the final file’s own folder', () => {
    fc.assert(
      fc.property(serverPathText, remotePathText, randomHex, (folder, name, random) => {
        const root = folder as ServerPath;
        const path = name as RemotePath;
        const final = joinServer(root, path);
        const temporary = joinServer(root, tempPathFor(path, random));
        expect(temporary).toBe(tempNameFor(final, random));
        expect(posix.dirname(temporary)).toBe(posix.dirname(final));
        expect(temporary).not.toBe(final);
      }),
      propertyOptions,
    );
  });
});
