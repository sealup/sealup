// The 375 px check (I-102, spec #41 decision 42), proven to bite: a page wider than a phone, so
// that it scrolls sideways, fails; a long line in a code block that scrolls on its own does not.
// It opens each page in the machine's Chrome (the GitHub runners have one). One build holds the
// pages that fit and the ones that don't, so Chrome starts once.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, it } from 'node:test';
import { widePages } from '../scripts/site-checks.ts';

const temps: string[] = [];
after(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

function build(files: Readonly<Record<string, string>>): string {
  const dist = mkdtempSync(join(tmpdir(), 'sealup-width-'));
  temps.push(dist);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

const page = (body: string): string =>
  [
    '<!doctype html><html><head><title>x</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="stylesheet" href="/site.css">',
    `</head><body>${body}</body></html>`,
  ].join('');

const longLine = 'sealup deploy production --json '.repeat(10);

it('names the pages that scroll sideways at 375 px, and only those', async () => {
  const dist = build({
    'site.css': [
      '.scrolls { overflow-x: auto; }',
      'p { overflow-wrap: anywhere; }',
      '.wide { width: 600px; }',
    ].join('\n'),
    // Fit: plain text, a code block that scrolls on its own, a long word that wraps.
    'index.html': page('<p>Deploy your build to shared hosting.</p>'),
    'deploy/index.html': page(
      `<pre class="scrolls"><code>${longLine}</code></pre><p>${'x'.repeat(200)}</p>`,
    ),
    // Too wide: a fixed-width block; a code block that pushes the page wider.
    'e/usage/index.html': page('<div class="wide">too wide</div>'),
    'config/index.html': page(`<pre><code>${longLine}</code></pre>`),
  });
  const wide = await widePages(dist);
  assert.equal(wide.length, 2, wide.join('\n'));
  assert.match(wide[0] ?? '', /^\/config\/: \d+ px wide at 375 px$/);
  assert.match(wide[1] ?? '', /^\/e\/usage\/: \d+ px wide at 375 px$/);
});
