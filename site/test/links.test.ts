// The internal link check (spec #41 decision 42), proven to bite: a link or asset of the site
// that leads to no file, or to no element of that id, fails; links to other hosts are not ours.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { brokenLinks } from '../scripts/site-checks.ts';

const temps: string[] = [];
after(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

/** A build folder holding these files. */
function build(files: Readonly<Record<string, string>>): string {
  const dist = mkdtempSync(join(tmpdir(), 'sealup-links-'));
  temps.push(dist);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

const page = (body: string): string =>
  `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`;

const site = {
  'deploy/index.html': page('<h1 id="_top">deploy</h1>'),
  'config/index.html': page('<h2 id="upload">upload</h2>'),
  '_astro/site.css': 'body{}',
  'favicon.svg': '<svg/>',
};

describe('internal links, proven to bite', () => {
  it('passes links to pages, anchors, assets and other hosts', () => {
    const dist = build({
      ...site,
      'index.html': page(
        [
          '<link rel="stylesheet" href="/_astro/site.css">',
          '<link rel="icon" href="/favicon.svg">',
          '<a href="/deploy/">deploy</a>',
          '<a href="/deploy">deploy</a>',
          '<a href="deploy/">deploy</a>',
          '<a href="/config/#upload">upload</a>',
          '<a href="https://sealup.dev/config/#upload">upload</a>',
          '<a href="#_top">top</a><span id="_top"></span>',
          '<a href="https://example.com/nowhere/">elsewhere</a>',
          '<a href="mailto:someone@example.com">mail</a>',
        ].join(''),
      ),
    });
    assert.deepEqual(brokenLinks(dist), []);
  });

  it("passes the 404 page's canonical link, which no visitor follows", () => {
    const dist = build({
      ...site,
      '404.html': '<link rel="canonical" href="https://sealup.dev/404/"/><a href="/deploy/">x</a>',
    });
    assert.deepEqual(brokenLinks(dist), []);
  });

  it('names a link to a page that is not built', () => {
    const dist = build({ ...site, 'index.html': page('<a href="/nowhere/">x</a>') });
    assert.deepEqual(brokenLinks(dist), ['/: /nowhere/']);
  });

  it('names a link to an id the page does not hold', () => {
    const dist = build({ ...site, 'deploy/index.html': page('<a href="/config/#nope">x</a>') });
    assert.deepEqual(brokenLinks(dist), ['/deploy/: /config/#nope']);
  });

  it('names a relative link and a missing asset', () => {
    const dist = build({
      ...site,
      'e/usage/index.html': page(
        '<link rel="stylesheet" href="/_astro/gone.css"><a href="../missing/">x</a>',
      ),
    });
    assert.deepEqual(brokenLinks(dist), ['/e/usage/: /_astro/gone.css', '/e/usage/: ../missing/']);
  });

  it('names a sealup.dev link to a page that is not built', () => {
    const dist = build({ ...site, 'index.html': page('<a href="https://sealup.dev/e/gone">x</a>') });
    assert.deepEqual(brokenLinks(dist), ['/: https://sealup.dev/e/gone']);
  });
});
