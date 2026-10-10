// The site's CI checks on a build (spec sealup/sealup#41 decision 42, decision 0036):
//
//   node scripts/check-site.ts [dist]     default: dist/, after `npm run build`
//
// 1. every docs slug and every sealup.dev URL in `help` has a page
// 2. no internal link or asset leads nowhere
// 3. no page scrolls sideways at 375 px (I-102), in the machine's Chrome or $CHROME_PATH
//
// One line per finding, then one status line per check. Exit 0 when all pass, 1 otherwise.

import { join } from 'node:path';
import { brokenLinks, missingPages, requiredPages, widePages } from './site-checks.ts';

const dist = join(process.cwd(), process.argv[2] ?? 'dist');

const required = requiredPages();
const missing = missingPages(dist, required);
for (const path of missing) console.error(`no page for sealup.dev${path}`);
const broken = brokenLinks(dist);
for (const link of broken) console.error(`broken link on ${link}`);
const wide = await widePages(dist);
for (const page of wide) console.error(`scrolls sideways: ${page}`);

const status = (count: number, ok: string, failed: string): string =>
  count === 0 ? `  ok  ${ok}` : `  ✗   ${failed}`;
console.error(
  [
    status(missing.length, `${required.length} pages the CLI links`, `${missing.length} missing`),
    status(broken.length, 'internal links', `${broken.length} broken link(s)`),
    status(wide.length, 'every page fits 375 px', `${wide.length} page(s) too wide`),
  ].join('\n'),
);
process.exitCode = missing.length + broken.length + wide.length === 0 ? 0 : 1;
