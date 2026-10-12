// A public repository (decision 0045, spec sealup/sealup-private#88 decisions 6 and 9): the
// security page says what init's question writes, what CI masks and its limit, and what really
// stops a changed sealup.yml; no page credits a `${NAME}` server with stopping it. The config
// page's hidden form is in config-page.test.ts, the home page's note in home.test.ts; the build's
// link check proves each link and anchor resolves.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const docs = join(import.meta.dirname, '..', 'src', 'content', 'docs');
const read = (...path: string[]): string => readFileSync(join(...path), 'utf8');

/** A page's section under this `## ` heading, up to the next one. */
function section(page: string, heading: string): string {
  const found = page.split(/^## /m).find((part) => part.startsWith(`${heading}\n`));
  assert.ok(found !== undefined, `a section "## ${heading}"`);
  return found;
}

describe("the security page's section on a public repository", () => {
  const text = section(read(docs, 'security.mdx'), 'A public repository').replace(/\s+/g, ' ');

  it("gives init's question and its three variables", () => {
    assert.match(text, /Is this repository public\?/);
    for (const name of ['SEALUP_SERVER', 'SEALUP_HOST_KEY', 'SEALUP_TLS_FINGERPRINT']) {
      assert.match(text, new RegExp(`\\$\\{${name}\\}`), name);
    }
  });

  it('says CI masks them, names the variable in the summary, and keeps the terminal whole', () => {
    assert.match(text, /masked/);
    assert.match(text, /job summary/);
    assert.match(text, /sftp:\/\/\*\*\*@\*\*\*/);
  });

  it('gives the masking limit: a user named like a common word, so a distinct deploy user', () => {
    assert.match(text, /common word/);
    assert.match(text, /distinct deploy user/);
  });

  it('says what stops a changed sealup.yml: an environment only main may use, review on main', () => {
    assert.match(text, /environment/);
    assert.match(text, /only `main`/);
    assert.match(text, /review/);
  });

  it('says how to hide a host key saved later, and where a certificate pin comes from', () => {
    assert.match(text, /\(\/keyscan\/#a-public-repository-without-a-saved-key\)/);
    assert.match(text, /never pins/);
  });
});

describe('no page credits a ${NAME} server with stopping a changed sealup.yml', () => {
  const pages = {
    'security.mdx': read(docs, 'security.mdx'),
    'github-action.mdx': read(docs, 'github-action.mdx'),
    'SECURITY.md': read(import.meta.dirname, '..', '..', 'SECURITY.md'),
  };

  for (const [name, page] of Object.entries(pages)) {
    it(name, () => {
      assert.doesNotMatch(page, /can(no|')t send your password/);
    });
  }

  it("the Action page's Secrets section points to the public repository section", () => {
    const secrets = section(pages['github-action.mdx'], 'Secrets');
    assert.match(secrets, /\(\/security\/#a-public-repository\)/);
    assert.match(secrets, /only `main`/);
  });
});

describe("the keyscan page's public repository without a saved key", () => {
  const text = read(docs, 'keyscan.md');

  it('says to write the reference by hand, then let keyscan show the line to set', () => {
    const own = section(text, 'A public repository without a saved key');
    assert.match(own, /hostKey: \$\{SEALUP_HOST_KEY\}/);
    assert.match(own, /plain text/);
  });
});
