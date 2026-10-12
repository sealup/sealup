// The `write:` page (spec sealup/sealup-private#88 decision 30): every error page that can be
// about a `write:` entry sends its reader there. The config page's link is in
// config-page.test.ts; the build's link check proves each link resolves.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const errors = join(import.meta.dirname, '..', 'src', 'content', 'docs', 'e');

describe('the error pages about a write: entry', () => {
  // secret-file-public: the public-folder net and FTP's mode; same-server-path: a write on an
  // upload's path; secret-in-config and config-invalid: a file's content written in sealup.yml.
  const pages = ['secret-file-public', 'same-server-path', 'secret-in-config', 'config-invalid'];

  for (const page of pages) {
    it(`${page} links to /write/`, () => {
      assert.match(readFileSync(join(errors, `${page}.md`), 'utf8'), /\]\(\/write\/\)/);
    });
  }
});
