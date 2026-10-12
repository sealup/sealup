// The theme switch check (spec sealup/sealup-private#88 decisions 23 and 25, plan 06 ruling 4),
// proven to bite: the home page and a docs page each have one switch, a button named for what a
// click does; a click (or Enter) switches the theme, and the choice shows on the other page; the
// docs header's GitHub link takes the text colour, the accent on hover; the home page's header
// shows the GitHub icon, not a label. It opens the pages in the machine's Chrome, as the width
// check does.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { themeProblems } from '../scripts/site-checks.ts';

const temps: string[] = [];
after(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

function build(files: Readonly<Record<string, string>>): string {
  const dist = mkdtempSync(join(tmpdir(), 'sealup-theme-'));
  temps.push(dist);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

const css = [
  ':root { --sl-color-text: #3d3438; --sl-color-text-accent: #1e6b45; }',
  ":root[data-theme='dark'] { --sl-color-text: #d6ccc2; --sl-color-text-accent: #b9e3c9; }",
  'body { color: var(--sl-color-text); }',
  'a[rel="me"] { color: var(--sl-color-text); }',
  'a[rel="me"]:hover { color: var(--sl-color-text-accent); }',
].join('\n');

// A small switch of its own: the check judges what a page does, not how.
const script = (start: string): string => `
  const key = 'starlight-theme';
  const read = () => { const s = localStorage.getItem(key); return s === 'light' || s === 'dark' ? s : undefined; };
  const shown = () => read() ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const show = (t) => {
    document.documentElement.dataset.theme = t;
    for (const b of document.querySelectorAll('[data-switch]')) {
      b.setAttribute('aria-label', 'Switch to ' + (t === 'dark' ? 'light' : 'dark') + ' theme');
    }
  };
  for (const b of document.querySelectorAll('[data-switch]')) {
    b.onclick = () => { const t = shown() === 'dark' ? 'light' : 'dark'; localStorage.setItem(key, t); show(t); };
  }
  show(${start});`;

const toggle = '<button type="button" data-switch>T</button>';
// Looks the same to a mouse, but Enter does nothing.
const mouseOnly = '<span role="button" tabindex="0" data-switch>T</span>';
const threeButtons = [
  '<div role="radiogroup" aria-label="Theme">',
  '<button role="radio" aria-label="System">S</button>',
  '<button role="radio" aria-label="Light">L</button>',
  '<button role="radio" aria-label="Dark">D</button>',
  '</div>',
].join('');

const page = (body: string, start = 'shown()'): string =>
  [
    '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="/site.css"></head>',
    `<body><header>${body}</header><script>${script(start)}</script></body></html>`,
  ].join('');

const githubLink = (inner: string, style = ''): string =>
  `<a rel="me" href="https://github.com/sealup/sealup"${style}>${inner}</a>`;
const githubIcon = githubLink('<svg aria-label="GitHub" role="img" width="16" height="16"></svg>');
const githubLabel = githubLink('GitHub');

describe('the theme switch, proven to bite', () => {
  it('passes one toggle whose choice carries between the pages, and the GitHub icon in the text colour', async () => {
    const dist = build({
      'site.css': css,
      'index.html': page(`${githubIcon}${toggle}`),
      'getting-started/index.html': page(`${githubIcon}${toggle}`),
    });
    assert.deepEqual(await themeProblems(dist), []);
  });

  it('names a choice that does not carry, a GitHub link in the accent, and a GitHub label', async () => {
    const accent = ' style="color: var(--sl-color-text-accent)"';
    const forgetful = build({
      'site.css': css,
      'index.html': page(`${githubLabel}${toggle}`, "'dark'"),
      'getting-started/index.html': page(`${githubLink('<svg aria-label="GitHub" role="img"></svg>', accent)}${toggle}`),
    });
    assert.deepEqual(await themeProblems(forgetful), [
      '/getting-started/: the GitHub link is not in the text colour (light theme)',
      '/: the header shows the GitHub label, not its icon',
      '/: light, chosen on /getting-started/, is not shown (dark theme, switch named "Switch to light theme")',
      '/: a click on the switch does not switch the theme (dark theme)',
      '/getting-started/: the GitHub link is not in the text colour (dark theme)',
    ]);
  });

  it('names a page without one toggle, and a toggle the keyboard cannot use', async () => {
    const radios = build({
      'site.css': css,
      'index.html': page(`${githubIcon}${threeButtons}`),
      'getting-started/index.html': page(`${githubIcon}${toggle}`),
    });
    assert.deepEqual(await themeProblems(radios), [
      '/: no theme switch (one button named "Switch to light theme" or "Switch to dark theme")',
    ]);
    const mouse = build({
      'site.css': css,
      'index.html': page(`${githubIcon}${toggle}`),
      'getting-started/index.html': page(`${githubIcon}${mouseOnly}`),
    });
    assert.deepEqual(await themeProblems(mouse), [
      '/getting-started/: Enter on the switch does not switch the theme',
    ]);
  });
});
