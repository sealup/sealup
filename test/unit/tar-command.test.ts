// R15 (0034): the SSH archive's one remote command. Only the target root goes in it, after R10
// and a strict character set, single-quoted by this one function; anything else throws.

import { describe, expect, it } from 'vitest';
import { tarCommand } from '../../src/transport/index.ts';

describe('tarCommand: the one remote command of the SSH archive', () => {
  it.each([
    ['/home/site', "tar -xmzf - -C '/home/site'"],
    ['/', "tar -xmzf - -C '/'"],
    ['/home/u-1/www.example.com_v2', "tar -xmzf - -C '/home/u-1/www.example.com_v2'"],
    ['/srv/a+b@c,d=e:f~g', "tar -xmzf - -C '/srv/a+b@c,d=e:f~g'"],
  ])('quotes %s', (root, command) => {
    expect(tarCommand(root)).toBe(command);
  });

  it.each([
    ['a quote', "/home/it's"],
    ['a space', '/home/my site'],
    ['a command substitution', '/home/$(touch pwned)'],
    ['a backtick', '/home/`id`'],
    ['a semicolon', '/home/x;rm -rf ~'],
    ['a line break', '/home/x\nid'],
    ['a non-ASCII letter', '/home/café'],
    ['a relative path', 'home/site'],
    ['a dot-dot segment', '/home/../etc'],
    ['an option', '-rf'],
  ])('refuses a root with %s', (_, root) => {
    expect(() => tarCommand(root)).toThrow(RangeError);
  });
});
