// The sidebar (astro.config.mjs takes it from src/sidebar.ts): every docs page is in it, so none
// is reachable only by a link, and `write:` has its page in the "Deploys" group (spec
// sealup/sealup-private#88 decision 30). The error pages fill their group by themselves.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { pagesOutsideSidebar, sidebar } from '../src/sidebar.ts';

const docs = join(import.meta.dirname, '..', 'src', 'content', 'docs');

/** The docs pages as slugs, `e/…` ones included; config.md is built at each build, so named. */
const slugs = [
  ...new Set([
    'config',
    ...readdirSync(docs, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
      .map((entry) => relative(docs, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .map((page) => page.replace(/\.mdx?$/, '')),
  ]),
].sort();

describe('the sidebar', () => {
  it('lists every docs page', () => {
    assert.deepEqual(pagesOutsideSidebar(slugs, sidebar), []);
  });

  it('has the write: page in the Deploys group', () => {
    const deploys = sidebar.find((group) => group.label === 'Deploys');
    assert.ok(deploys?.items.includes('write'));
  });
});

describe('pages outside the sidebar, proven to bite', () => {
  const groups = [
    { label: 'Start here', items: ['getting-started'] },
    { label: 'Errors', items: [{ autogenerate: { directory: 'e' } }] },
  ];

  it('passes pages listed, or in a folder a group fills by itself', () => {
    assert.deepEqual(pagesOutsideSidebar(['getting-started', 'e/usage'], groups), []);
  });

  it('names a page no group lists', () => {
    assert.deepEqual(pagesOutsideSidebar(['getting-started', 'write', 'e/usage'], groups), [
      'write',
    ]);
  });
});
