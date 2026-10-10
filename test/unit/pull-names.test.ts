// A name a server lists, before `sealup pull` writes it on this machine (R10 with the Windows
// rules, R19, R21's 255 bytes): one name, never a path. The cases are exploration 03's (R19's
// test: `../x`, `..\x`, `CON`, `a/b\c`) and the Windows file naming rules.

import { describe, expect, it } from 'vitest';
import { pullNameProblem } from '../../src/paths/index.ts';

describe('pullNameProblem: a server name pull may write here', () => {
  it.each([
    'photo.jpg',
    '.htaccess',
    '__proto__',
    'constructor',
    'my photo (1).jpg',
    'café.jpg',
    'CONSOLE.txt',
    'COM10',
    'a..b',
    'é'.repeat(127),
  ])('takes %j', (name) => {
    expect(pullNameProblem(name)).toBeUndefined();
  });

  it.each([
    ['', 'dot-name'],
    ['.', 'dot-name'],
    ['..', 'dot-name'],
    ['../x', 'slash'],
    ['a/b', 'slash'],
    ['..\\x', 'backslash'],
    ['a\\c', 'backslash'],
    ['line\nbreak', 'control-character'],
    ['tab\there', 'control-character'],
    ['del\u007f', 'control-character'],
    ['café.jpg', 'not-nfc'],
    ['a<b', 'windows-character'],
    ['a>b', 'windows-character'],
    ['C:x', 'windows-character'],
    ['say "hi"', 'windows-character'],
    ['a|b', 'windows-character'],
    ['why?', 'windows-character'],
    ['*.jpg', 'windows-character'],
    ['CON', 'windows-reserved'],
    ['con', 'windows-reserved'],
    ['NUL.txt', 'windows-reserved'],
    ['aux.tar.gz', 'windows-reserved'],
    ['PRN', 'windows-reserved'],
    ['COM1', 'windows-reserved'],
    ['lpt9.log', 'windows-reserved'],
    ['COM¹', 'windows-reserved'],
    ['CON ', 'trailing-dot-space'],
    ['name.', 'trailing-dot-space'],
    ['name ', 'trailing-dot-space'],
    ['a'.repeat(256), 'too-long'],
    ['é'.repeat(128), 'too-long'],
    ['.photo.jpg.sealup-0123456789abcdef.tmp', 'sealup-temp'],
  ])('refuses %j (%s)', (name, problem) => {
    expect(pullNameProblem(name)).toBe(problem);
  });
});
