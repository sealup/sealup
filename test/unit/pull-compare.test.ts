// The pull comparison (spec #24 decision 25, owner ruling 7): a local file is "already here" when
// it has the server's size and the server's modification time in whole seconds; otherwise the
// server's copy replaces it; no local file at all is new.

import { describe, expect, it } from 'vitest';
import { comparePull } from '../../src/pull/index.ts';

const server = { size: 2048, mtime: 1_700_000_000 };

describe('comparePull', () => {
  it('is new when there is no local file', () => {
    expect(comparePull(server, undefined)).toBe('new');
  });

  it.each([
    ['the same second', 1_700_000_000_000],
    ['a fraction later in that second (file systems keep milliseconds)', 1_700_000_000_999],
  ])('is already here with the same size and %s', (_, mtimeMs) => {
    expect(comparePull(server, { size: 2048, mtimeMs })).toBe('unchanged');
  });

  it.each([
    ['another size, the same date', { size: 2047, mtimeMs: 1_700_000_000_000 }],
    ['the same size, a second earlier', { size: 2048, mtimeMs: 1_699_999_999_999 }],
    ['the same size, a second later', { size: 2048, mtimeMs: 1_700_000_001_000 }],
    ['an empty file', { size: 0, mtimeMs: 1_700_000_000_000 }],
  ])('replaces a local file with %s', (_, local) => {
    expect(comparePull(server, local)).toBe('replace');
  });
});
