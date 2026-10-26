import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Manifest, RemotePath, ServerPath, Sha256 } from '../../src/contracts/index.ts';
import { decode, encode } from '../../src/manifest/index.ts';
import { tempPathFor } from '../../src/paths/index.ts';
import {
  propertyOptions,
  randomHex,
  remotePathText,
  serverPathText,
  sha256Hex,
  unsafePathText,
} from '../property-kit.ts';

const records = fc.uniqueArray(
  fc.record({
    path: remotePathText,
    size: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    sha256: sha256Hex,
  }),
  { selector: (r) => r.path, maxLength: 20 },
);
const manifests = fc.tuple(serverPathText, records, randomHex).map(
  ([folder, entries, random]): Manifest => ({
    format: 2,
    folder: folder as ServerPath,
    files: new Map(
      entries.map(({ path, size, sha256 }) => [
        path as RemotePath,
        { size, sha256: sha256 as Sha256 },
      ]),
    ),
    pending: entries.map(({ path }) => tempPathFor(path as RemotePath, random)),
  }),
);
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe('untrusted manifest properties (R11, R12, format 2)', () => {
  it('round-trips every file, size, digest and pending upload, including special object-key names', () => {
    fc.assert(
      fc.property(manifests, (manifest) => {
        expect(decode(encode(manifest))).toEqual(manifest);
      }),
      propertyOptions,
    );
  });

  it('refuses paths that could escape or alias files, in both supported wire formats', () => {
    fc.assert(
      fc.property(serverPathText, unsafePathText, sha256Hex, (folder, path, sha256) => {
        for (const format of [1, 2]) {
          expect(
            decode(
              bytes({
                format,
                folder,
                files: [{ path, size: 0, sha256 }],
                ...(format === 2 ? { pending: [] } : {}),
              }),
            ),
          ).toBeUndefined();
        }
      }),
      propertyOptions,
    );
  });

  it('never treats an ordinary site file as a pending temporary eligible for cleanup', () => {
    fc.assert(
      fc.property(serverPathText, remotePathText, (folder, path) => {
        expect(
          decode(bytes({ format: 2, folder, files: [], pending: [`${path}.html`] })),
        ).toBeUndefined();
      }),
      propertyOptions,
    );
  });

  it('refuses duplicate records instead of silently replacing a file’s size and digest', () => {
    fc.assert(
      fc.property(serverPathText, remotePathText, sha256Hex, (folder, path, sha256) => {
        expect(
          decode(
            bytes({
              format: 2,
              folder,
              files: [
                { path, size: 0, sha256 },
                { path, size: 1, sha256 },
              ],
              pending: [],
            }),
          ),
        ).toBeUndefined();
      }),
      propertyOptions,
    );
  });

  it('handles arbitrary bytes and JSON as data, and preserves anything it accepts', () => {
    const input = fc.oneof(
      fc.uint8Array({ maxLength: 1024 }),
      fc.jsonValue({ maxDepth: 3 }).map(bytes),
      manifests.map(encode),
    );
    fc.assert(
      fc.property(input, (data) => {
        const manifest = decode(data);
        if (manifest !== undefined) expect(decode(encode(manifest))).toEqual(manifest);
      }),
      propertyOptions,
    );
  });
});
