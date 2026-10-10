// The path rule's local side (R10, decision 0019): the checks that keep a local path, or a path
// written in a sam-sync file, inside its folder. Segment by segment, so a name such as `..x` is a
// name, never a climb (review of lane C, Standards 4).

import { describe, expect, it } from 'vitest';
import { folderInside, normalizePath, staysInside } from '../../src/paths/index.ts';

describe('normalizePath', () => {
  it.each([
    ['a/b', 'a/b'],
    ['./a//b/', 'a/b'],
    ['a/./b/../c', 'a/c'],
    ['.', ''],
    ['', ''],
    ['a/..', ''],
    ['..x/y', '..x/y'],
    ['/home/site/', '/home/site'],
    ['/home//site/./www/..', '/home/site'],
    ['/', '/'],
    ['/..', '/'],
    ['/a/../../b', '/b'],
  ])('reads %j as %j', (path, normal) => {
    expect(normalizePath(path)).toBe(normal);
  });

  it.each(['..', '../a', 'a/../..', './../a'])('refuses %j: it climbs out', (path) => {
    expect(normalizePath(path)).toBeUndefined();
  });
});

describe('staysInside: a path relative to a folder, as path.relative gives it', () => {
  it.each([
    ['', 'posix'],
    ['dist', 'posix'],
    ['a/b', 'posix'],
    ['..x', 'posix'],
    ['..x/y', 'posix'],
    ['a\\b', 'win32'],
    ['..x\\y', 'win32'],
  ] as const)('keeps %j (%s) inside', (relative, platform) => {
    expect(staysInside(relative, platform)).toBe(true);
  });

  it.each([
    ['..', 'posix'],
    ['../a', 'posix'],
    ['/abs', 'posix'],
    ['..\\a', 'win32'],
    ['../a', 'win32'],
    ['D:\\other', 'win32'],
    ['\\\\server\\share', 'win32'],
  ] as const)('finds %j (%s) outside', (relative, platform) => {
    expect(staysInside(relative, platform)).toBe(false);
  });
});

describe('folderInside: a folder inside this one, as a person types it', () => {
  it.each([
    ['dist', 'dist'],
    ['./dist/', 'dist'],
    ['  build\\out\\  ', 'build/out'],
    ['..x', '..x'],
  ])('reads %j as %j', (typed, folder) => {
    expect(folderInside(typed)).toBe(folder);
  });

  it.each(['', '  ', '.', '/abs', 'C:\\x', 'a/../b', '..', 'a\u0007b'])('refuses %j', (typed) => {
    expect(folderInside(typed)).toBeUndefined();
  });
});
