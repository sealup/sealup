// The coverage check (spec #41 decision 42), proven to bite: every slug in docs-slugs.golden and
// every sealup.dev URL in `help` must have a page in the build; a build without one fails.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { missingPages, requiredPages } from '../scripts/site-checks.ts';

const temps: string[] = [];
after(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

/** A build folder holding an index.html for each path. */
function build(paths: readonly string[]): string {
  const dist = mkdtempSync(join(tmpdir(), 'sealup-site-'));
  temps.push(dist);
  for (const path of paths) {
    mkdirSync(join(dist, path), { recursive: true });
    writeFileSync(join(dist, path, 'index.html'), '<!doctype html><title>x</title>');
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

  it('names the help URL whose page is missing', () => {
    const required = requiredPages();
    const dist = build(required.filter((path) => path !== '/exit-codes/'));
    assert.deepEqual(missingPages(dist, required), ['/exit-codes/']);
  });
});
