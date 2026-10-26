// Generators for documented security boundaries, independent of the validators under test.
// Include NFC/NFD accents, non-Latin names, spaces and JavaScript object-key names.
import * as fc from 'fast-check';

const segment = fc.oneof(
  fc.constantFrom('__proto__', 'constructor', 'toString', 'café', '中', '💾'),
  fc
    .array(fc.constantFrom('a', 'B', '0', '.', ' ', ':', 'é', 'e\u0301', '中', '💾', '_', '-'), {
      maxLength: 12,
    })
    .map((chars) => `file-${chars.join('').normalize('NFC')}`),
);

export const remotePathText = fc
  .array(segment, { minLength: 1, maxLength: 6 })
  .map((s) => s.join('/'));
export const serverPathText = fc.oneof(
  fc.constant('/'),
  remotePathText.map((p) => `/root/${p}`),
);
export const unsafePathText = fc.oneof(
  remotePathText.map((p) => `../${p}`),
  remotePathText.map((p) => `${p}/../escape`),
  remotePathText.map((p) => `${p}/./alias`),
  remotePathText.map((p) => `${p}//alias`),
  remotePathText.map((p) => `/${p}`),
  remotePathText.map((p) => `C:${p}`),
  remotePathText.map((p) => `${p}\\escape`),
  fc
    .tuple(remotePathText, fc.integer({ min: 0, max: 31 }))
    .map(([p, c]) => `${p}${String.fromCharCode(c)}`),
  fc
    .tuple(remotePathText, fc.integer({ min: 127, max: 159 }))
    .map(([p, c]) => `${p}${String.fromCharCode(c)}`),
  remotePathText.map((p) => `${p}/cafe\u0301`),
);

const hex = (length: number) =>
  fc
    .array(fc.constantFrom(...'0123456789abcdef'), { minLength: length, maxLength: length })
    .map((c) => c.join(''));

export const randomHex = hex(16);
export const sha256Hex = hex(64);
// Each failure includes fast-check's seed and shrink path for replay. Bound CI work, rather
// than wall-clock time, so Windows and Linux exercise the same number of generated cases.
export const propertyOptions = { numRuns: 300 };
