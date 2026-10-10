// The config page is built from schema.json (spec #41 decision 40, I-098), so the site never
// drifts from the config sealup accepts: every key of the schema has its section, and the page
// names every key `sealup help config` lists.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { configPage } from '../scripts/config-page.ts';

const schema: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'schema.json'), 'utf8'),
);

describe('the config page from schema.json', () => {
  const page = configPage(schema);

  it('has a section for each key help config lists', () => {
    const keys = ['server', 'password', 'hostKey', 'url', 'upload', 'exclude', 'write', 'pull'];
    const more = ['targets', 'allow', 'parallel', 'timeout', 'manifest'];
    for (const key of [...keys, ...more]) {
      assert.match(page, new RegExp(`^### \`${key}\`$`, 'm'), `a section for ${key}`);
    }
  });

  it("names the keys inside an entry: write's from, mode and allowPublic, upload's to", () => {
    for (const key of ['from', 'mode', 'allowPublic', 'to']) {
      assert.match(page, new RegExp(`\\| \`${key}\` \\|`), `a row for ${key}`);
    }
  });

  it('gives a key its description, its values and its range', () => {
    assert.match(page, /SFTP requests in flight \(default 64\); FTP connections \(default 4/);
    assert.match(page, /`empty-source`/);
    assert.match(page, /from 1 to 256/);
  });
});

describe('a key the schema gains', () => {
  it('gets its section with no change to the page code', () => {
    const page = configPage({
      anyOf: [
        {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'The server' },
            mirror: { type: 'boolean', description: 'Delete what is not in the build' },
          },
          required: ['server'],
        },
      ],
    });
    assert.match(page, /^### `mirror`$/m);
    assert.match(page, /Delete what is not in the build/);
    assert.match(page, /true or false/);
  });
});
