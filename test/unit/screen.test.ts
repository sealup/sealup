// testkit's terminal emulator (screenOf): what a terminal shows once a stream is written. The
// goldens read the screen through it, so it must model each control sequence report writes:
// the progress line's erase, and the prompts' redraws (cursor up, erase down, cursor hidden).

import { describe, expect, it } from 'vitest';
import { screenOf } from '../../src/testkit/index.ts';

describe('screenOf', () => {
  it('keeps plain lines and colour codes as they are', () => {
    expect(screenOf('a\n\u001b[1mb\u001b[22m\n')).toBe('a\n\u001b[1mb\u001b[22m\n');
  });

  it('drops a line erased and replaced (the progress line)', () => {
    expect(screenOf('a\n\r\u001b[2K50 %\r\u001b[2K100 %\r\u001b[2Kb\n')).toBe('a\nb\n');
  });

  it('redraws lines after the cursor goes up and erases to the end of the screen', () => {
    const raw =
      'q\n  › one\n    two\n\u001b[2A\u001b[J    one\n  › two\n\u001b[2A\u001b[J  ✓ two\n';
    expect(screenOf(raw)).toBe('q\n  ✓ two\n');
  });

  it('does not show the cursor being hidden and shown again', () => {
    expect(screenOf('\u001b[?25lq\n\u001b[?25h')).toBe('q\n');
  });

  it('refuses text written over a line that was not cleared', () => {
    expect(() => screenOf('abc\rx')).toThrow(/not cleared/);
    expect(() => screenOf('a\nb\n\u001b[2Ax\n')).toThrow(/not cleared/);
  });

  it('refuses a control sequence it does not model', () => {
    expect(() => screenOf('\u001b[5C')).toThrow(/does not model/);
  });
});
