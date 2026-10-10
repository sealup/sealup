// The terminal's questions (spec #24 decisions 15-16): the target picker, a yes/no question and a
// hidden answer, driven by key sequences as a terminal in raw mode sends them, the screen read
// through testkit's terminal emulator. cli asks; report draws (redacted, 80 columns).

import { describe, expect, it } from 'vitest';
import { createPrompts } from '../../src/cli/index.ts';
import { createPromptView } from '../../src/report/index.ts';
import { screenOf } from '../../src/testkit/index.ts';
import { typing } from '../deploy-kit.ts';

const up = '\u001b[A';
const down = '\u001b[B';
const enter = '\r';
const esc = '\u001b';
const ctrlC = '\u0003';
const backspace = '\u007f';

/** Prompts on a terminal without colour, typing `keys`; what it wrote, and the keyboard. */
function terminal(keys: readonly string[], signal?: AbortSignal) {
  let raw = '';
  const keyboard = typing(keys);
  const view = createPromptView({ write: (text) => (raw += text), color: false, terminal: true });
  return {
    prompts: createPrompts(keyboard, view, signal),
    keyboard,
    screen: () => screenOf(raw),
    raw: () => raw,
  };
}

const targets = [
  { label: 'production', hint: 'sftp://deploy@ssh.example.com/home/site' },
  { label: 'staging', hint: 'sftp://deploy@203.0.113.10/srv/site' },
];

describe('the picker', () => {
  it('shows each option with its hint, the cursor on the first, until Enter', async () => {
    const t = terminal([]);
    const asked = t.prompts.pick('Deploy to which target?', targets);
    expect(t.screen()).toBe(
      [
        'Deploy to which target?',
        '  › production   sftp://deploy@ssh.example.com/home/site',
        '    staging      sftp://deploy@203.0.113.10/srv/site',
        '',
      ].join('\n'),
    );
    expect(t.raw().startsWith('\u001b[?25l')).toBe(true);
    t.keyboard.type(enter);
    expect(await asked).toBe(0);
  });

  it('moves the cursor with the arrows and picks with Enter: the answer replaces the list', async () => {
    const t = terminal([down, up, down, enter]);
    expect(await t.prompts.pick('Deploy to which target?', targets)).toBe(1);
    expect(t.screen()).toBe(['Deploy to which target?', '  ✓ staging', '', ''].join('\n'));
  });

  it('stays on the first and last option when an arrow would go past them', async () => {
    expect(await terminal([up, enter]).prompts.pick('Which?', targets)).toBe(0);
    expect(await terminal([down, down, down, enter]).prompts.pick('Which?', targets)).toBe(1);
  });

  it('reads several keys sent at once (a fast typist, a paste)', async () => {
    expect(await terminal([`${down}${enter}`]).prompts.pick('Which?', targets)).toBe(1);
  });

  it('indents the options under an indented question', async () => {
    const t = terminal([enter]);
    await t.prompts.pick('  Upload which folder?', [{ label: 'dist' }, { label: 'public' }]);
    expect(t.screen()).toBe(['  Upload which folder?', '    ✓ dist', '', ''].join('\n'));
  });

  it.each([
    ['Esc', esc],
    ['Ctrl-C', ctrlC],
  ])('stops on %s with no answer: the list is erased, the cursor shown again', async (_, key) => {
    const t = terminal([down, key]);
    expect(await t.prompts.pick('Deploy to which target?', targets)).toBeUndefined();
    expect(t.screen()).toBe('Deploy to which target?\n');
    expect(t.raw().endsWith('\u001b[?25h')).toBe(true);
  });

  it('turns raw mode on while it asks, and off once answered', async () => {
    const t = terminal([enter]);
    const asked = t.prompts.pick('Which?', targets);
    expect(t.keyboard.rawMode()).toBe(true);
    await asked;
    expect(t.keyboard.rawMode()).toBe(false);
  });

  it('stops with no answer when the run is interrupted (SIGTERM) while it waits', async () => {
    const interrupt = new AbortController();
    const t = terminal([], interrupt.signal);
    const asked = t.prompts.pick('Which?', targets);
    interrupt.abort();
    expect(await asked).toBeUndefined();
    expect(t.keyboard.rawMode()).toBe(false);
  });
});

describe('a yes/no question', () => {
  it('shows its default in capitals; Enter alone takes it, and the line shows it', async () => {
    const no = terminal([enter]);
    expect(await no.prompts.yesNo('  Save it to sealup.yml as hostKey?', false)).toBe(false);
    expect(no.screen()).toBe('  Save it to sealup.yml as hostKey? [y/N] n\n');
    const yes = terminal([enter]);
    expect(await yes.prompts.yesNo('  Replace it?', true)).toBe(true);
    expect(yes.screen()).toBe('  Replace it? [Y/n] y\n');
  });

  it('takes y, yes, n and no in any case, as typed', async () => {
    expect(await terminal(['y', enter]).prompts.yesNo('  Save?', false)).toBe(true);
    expect(await terminal(['YES', enter]).prompts.yesNo('  Save?', false)).toBe(true);
    expect(await terminal(['n', enter]).prompts.yesNo('  Save?', true)).toBe(false);
    expect(await terminal(['No\r']).prompts.yesNo('  Save?', true)).toBe(false);
    const typed = terminal(['y', enter]);
    await typed.prompts.yesNo('  Save it to sealup.yml as hostKey?', false);
    expect(typed.screen()).toBe('  Save it to sealup.yml as hostKey? [y/N] y\n');
  });

  it('clears another answer and asks again; Backspace removes the last character', async () => {
    const t = terminal(['x', enter, 'nx', backspace, enter]);
    expect(await t.prompts.yesNo('  Save?', true)).toBe(false);
    expect(t.screen()).toBe('  Save? [Y/n] n\n');
  });

  it.each([
    ['Ctrl-C', ctrlC],
    ['Esc', esc],
  ])('stops on %s with no answer, the line ended', async (_, key) => {
    const t = terminal(['y', key]);
    expect(await t.prompts.yesNo('  Save?', false)).toBeUndefined();
    expect(t.screen()).toBe('  Save? [y/N] y\n');
    expect(t.keyboard.rawMode()).toBe(false);
  });
});

describe('a hidden answer (a password)', () => {
  const password = 'Hidd3n-pw!';

  it('echoes one • per character, never the characters, and returns what was typed', async () => {
    const t = terminal([...password, enter]);
    expect(await t.prompts.hidden('  Password for deploy@ssh.example.com:')).toBe(password);
    expect(t.screen()).toBe(`  Password for deploy@ssh.example.com: ${'•'.repeat(10)}\n`);
    expect(t.raw()).not.toContain('Hidd3n');
  });

  it('takes a paste in one chunk, and Backspace removes one character', async () => {
    const t = terminal([`${password}x`, backspace, enter]);
    expect(await t.prompts.hidden('  Password:')).toBe(password);
    expect(t.screen()).toBe(`  Password: ${'•'.repeat(10)}\n`);
  });

  it('keeps characters beyond the basic plane whole: one • each', async () => {
    const t = terminal(['p🔑w', backspace, enter]);
    expect(await t.prompts.hidden('  Password:')).toBe('p🔑');
    expect(t.screen()).toBe('  Password: ••\n');
  });

  it('ignores the arrows and other keys that type nothing', async () => {
    const t = terminal(['ab', up, '\u0001', 'c', enter]);
    expect(await t.prompts.hidden('  Password:')).toBe('abc');
  });

  it.each([
    ['Ctrl-C', ctrlC],
    ['Esc', esc],
  ])('stops on %s with no answer', async (_, key) => {
    const t = terminal(['abc', key]);
    expect(await t.prompts.hidden('  Password:')).toBeUndefined();
    expect(t.screen()).toBe('  Password: •••\n');
    expect(t.keyboard.rawMode()).toBe(false);
  });
});

describe('a visible answer (a server address)', () => {
  it('shows what is typed, Backspace removes one character, Enter returns it', async () => {
    const t = terminal(['sftp://deploy@ssh.example.com/x', backspace, 'www', enter]);
    expect(await t.prompts.text('  Server address:')).toBe('sftp://deploy@ssh.example.com/www');
    expect(t.screen()).toBe('  Server address: sftp://deploy@ssh.example.com/www\n');
    expect(t.keyboard.rawMode()).toBe(false);
  });

  it.each([
    ['Ctrl-C', ctrlC],
    ['Esc', esc],
  ])('stops on %s with no answer', async (_, key) => {
    const t = terminal(['sftp', key]);
    expect(await t.prompts.text('  Server address:')).toBeUndefined();
    expect(t.screen()).toBe('  Server address: sftp\n');
  });
});

describe('where Unicode is unsafe (the legacy Windows console, decision 0024 §3)', () => {
  it('draws > for the cursor and * for each hidden character', () => {
    let raw = '';
    const view = createPromptView({
      write: (text) => (raw += text),
      color: false,
      terminal: true,
      unicode: false,
    });
    view.picker('Which?', targets, 1);
    expect(screenOf(raw)).toContain('  > staging');
    view.picked('Which?', 'staging');
    view.hidden('  Password:', 3);
    expect(screenOf(raw)).toBe('Which?\n  √ staging\n\n  Password: ***');
  });
});

describe('keys left over', () => {
  it('go to the next question: typed ahead, as a terminal keeps them', async () => {
    const t = terminal([`${down}${enter}y${enter}`]);
    expect(await t.prompts.pick('Which?', targets)).toBe(1);
    expect(await t.prompts.yesNo('  Save?', false)).toBe(true);
  });
});
