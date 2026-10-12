// The coverage check (spec #41 decision 42), proven to bite: every slug in docs-slugs.golden and
// every sealup.dev URL in `help` must have a page in the build; a build without one fails.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { missingPages, requiredPages } from '../scripts/site-checks.ts';

const temps: string[] = [];
after(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

/** A build folder holding an index.html for each page path (`/x/`), and each file path as it is. */
function build(paths: readonly string[]): string {
  const dist = mkdtempSync(join(tmpdir(), 'sealup-site-'));
  temps.push(dist);
  for (const path of paths) {
    const file = path.endsWith('/') ? join(dist, path, 'index.html') : join(dist, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '<!doctype html><title>x</title>');
  }
  return dist;
}

describe('the pages the CLI links', () => {
  const required = requiredPages();

  it('holds one page per docs slug', () => {
    for (const slug of ['target-not-named', 'login-refused', 'config-exists', 'usage']) {
      assert.ok(required.includes(`/e/${slug}/`), `/e/${slug}/ is required`);
    }
  });

  it('holds every sealup.dev URL that help prints', () => {
    for (const path of ['/', '/init/', '/deploy/', '/pull/', '/keyscan/', '/check/']) {
      assert.ok(required.includes(path), `${path} is required`);
    }
    assert.ok(required.includes('/config/'));
    assert.ok(required.includes('/exit-codes/'));
  });

  // GitHub and npm load the README's wordmark from sealup.dev (spec #88 decision 27).
  it("holds every sealup.dev URL of the README, a file's path as it is", () => {
    for (const path of ['/brand/sealup-wordmark.svg', '/brand/sealup-wordmark-on-dark.svg']) {
      assert.ok(required.includes(path), `${path} is required`);
    }
  });
});

describe('missing pages, proven to bite', () => {
  it('finds none when every page is built', () => {
    const required = requiredPages();
    assert.deepEqual(missingPages(build(required), required), []);
  });

  it('names the slug whose page is missing', () => {
    const required = requiredPages();
    const dist = build(required.filter((path) => path !== '/e/login-refused/'));
    assert.deepEqual(missingPages(dist, required), ['/e/login-refused/']);
  });

  it("names the README's wordmark when the build lacks it", () => {
    const required = requiredPages();
    const dist = build(required.filter((path) => !path.endsWith('.svg')));
    assert.deepEqual(missingPages(dist, required), [
      '/brand/sealup-wordmark-on-dark.svg',
      '/brand/sealup-wordmark.svg',
    ]);
  });

  it('names the help URL whose page is missing', () => {
    const required = requiredPages();
    const dist = build(required.filter((path) => path !== '/exit-codes/'));
    assert.deepEqual(missingPages(dist, required), ['/exit-codes/']);
  });
});
