// The theme switch (plan 06 ruling 4): one button showing the active theme, a click switches to
// the other. The choice is kept where Starlight keeps its own (`starlight-theme`), so the docs,
// the home page and Starlight's own head script read the same value; nothing stored follows the
// system.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { otherTheme, readTheme, shownTheme, switchLabel } from '../src/theme/theme.ts';

describe('a stored theme', () => {
  it('reads light and dark as they are, anything else as no choice (the system)', () => {
    assert.equal(readTheme('light'), 'light');
    assert.equal(readTheme('dark'), 'dark');
    assert.equal(readTheme(''), undefined);
    assert.equal(readTheme(null), undefined);
    assert.equal(readTheme('auto'), undefined);
    assert.equal(readTheme('sepia'), undefined);
  });
});

describe('the theme a page shows', () => {
  it("is the stored one, or the system's when none is stored", () => {
    assert.equal(shownTheme('light', false), 'light');
    assert.equal(shownTheme('dark', true), 'dark');
    assert.equal(shownTheme(undefined, true), 'light');
    assert.equal(shownTheme(undefined, false), 'dark');
  });
});

describe('the switch', () => {
  it('goes to the other theme', () => {
    assert.equal(otherTheme('dark'), 'light');
    assert.equal(otherTheme('light'), 'dark');
  });

  it('is named for what a click does', () => {
    assert.equal(switchLabel('dark'), 'Switch to light theme');
    assert.equal(switchLabel('light'), 'Switch to dark theme');
  });
});
