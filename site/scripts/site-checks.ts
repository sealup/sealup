// The site's checks (spec sealup/sealup#41 decision 42, decision 0036), run on a build folder:
//   missingPages  every docs slug and every sealup.dev URL in `help` has a page
//
// The CLI's own words are the source: the slugs come from the frozen docs-slugs golden, the URLs
// from the help screens themselves (src/report/help.ts is pure: Node runs it as it is).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { helpLines, helpTopics } from '../../src/report/help.ts';

/** The repo root (this file lives in `site/scripts/`). */
const repoRoot = join(import.meta.dirname, '..', '..');

const slugsGolden = join(repoRoot, 'test', 'integration', 'goldens', 'seams', 'docs-slugs.golden');

/** The docs slugs, one a line, as the frozen golden holds them. */
function docsSlugs(): string[] {
  return readFileSync(slugsGolden, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Every help screen as plain text: `sealup --help`, then each topic. */
function helpText(): string {
  const screens = [helpLines(), ...helpTopics.map((topic) => helpLines(topic))];
  return screens
    .flatMap((lines) =>
      lines.map((line) =>
        line.map((segment) => (typeof segment === 'string' ? segment : segment.text)).join(''),
      ),
    )
    .join('\n');
}

/** A sealup.dev URL's path as the site serves it: `/`, `/deploy/`, `/e/login-refused/`. */
function pagePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return `${trimmed}/`;
}

/** The page paths the CLI links: one per docs slug, then one per sealup.dev URL in help. */
export function requiredPages(): string[] {
  const fromSlugs = docsSlugs().map((slug) => `/e/${slug}/`);
  const fromHelp = [...helpText().matchAll(/https:\/\/sealup\.dev(\/[\w./-]*)?/g)].map((match) =>
    pagePath(match[1] ?? '/'),
  );
  return [...new Set([...fromHelp, ...fromSlugs])];
}

/** The required paths with no index.html in the build folder, in the order given. */
export function missingPages(dist: string, required: readonly string[]): string[] {
  return required.filter((path) => !existsSync(join(dist, path, 'index.html')));
}

const origin = 'https://sealup.dev';

/** Every .html file of the build folder, as paths relative to it with `/`, sorted. */
export function htmlFiles(dist: string): string[] {
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** The path a visitor uses for an .html file: `deploy/index.html` → `/deploy/`. */
export function pageOf(file: string): string {
  return `/${file.replace(/(^|\/)index\.html$/, '$1')}`;
}

/** The HTML without the bodies of its scripts, whose strings are not links. */
function markup(html: string): string {
  return html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1');
}

const attribute = (name: string): RegExp =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'gi');

/** The values of one attribute, entities `&amp;` decoded, in document order. */
function attributeValues(html: string, name: string): string[] {
  return [...html.matchAll(attribute(name))].map((match) =>
    (match[1] ?? match[2] ?? match[3] ?? '').replaceAll('&amp;', '&'),
  );
}

/**
 * The links and assets of a page: every href and src, in document order. A canonical link names
 * the page itself for search engines and is not followed (the 404 page's names `/404/`).
 */
function references(html: string): string[] {
  const tags = [...html.matchAll(/<[a-z][^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/^<link\b[^>]*\brel\s*=\s*["']?canonical\b/i.test(tag));
  return tags.flatMap((tag) => [...attributeValues(tag, 'href'), ...attributeValues(tag, 'src')]);
}

/** The file of the build folder a site path is served from, if there is one. */
function servedFile(dist: string, path: string): string | undefined {
  const candidates = path.endsWith('/')
    ? [`${path}index.html`]
    : [path, `${path}/index.html`, `${path}.html`];
  return candidates
    .map((candidate) => join(dist, ...candidate.split('/')))
    .find((file) => existsSync(file) && statSync(file).isFile());
}

/**
 * The links and assets of the site that lead nowhere: no file for the path, or no element of
 * that id for the `#fragment`. Links to other hosts, and `mailto:` and the like, are not checked.
 * Each as `<page>: <href>`, pages sorted, links in document order.
 */
export function brokenLinks(dist: string): string[] {
  const ids = new Map<string, Set<string>>();
  const idsOf = (file: string): Set<string> => {
    let found = ids.get(file);
    if (found === undefined) {
      found = new Set(attributeValues(markup(readFileSync(file, 'utf8')), 'id'));
      ids.set(file, found);
    }
    return found;
  };
  const broken: string[] = [];
  for (const file of htmlFiles(dist)) {
    const page = pageOf(file);
    for (const href of references(markup(readFileSync(join(dist, file), 'utf8')))) {
      let url: URL;
      try {
        url = new URL(href, `${origin}${page}`);
      } catch {
        broken.push(`${page}: ${href}`);
        continue;
      }
      if (url.origin !== origin) continue;
      const target = servedFile(dist, decodeURIComponent(url.pathname));
      const fragment = decodeURIComponent(url.hash.slice(1));
      const found =
        target !== undefined &&
        (fragment === '' || !target.endsWith('.html') || idsOf(target).has(fragment));
      if (!found) broken.push(`${page}: ${href}`);
    }
  }
  return broken;
}

const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves the build folder on a free local port, as the site's host would. */
async function serve(dist: string): Promise<{ readonly url: string; readonly close: () => void }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const file = servedFile(dist, path);
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    const type = contentTypes[extname(file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** The phone width every page must fit (I-102). */
export const phoneWidth = 375;

/**
 * The pages that scroll sideways on a phone: wider than 375 px once laid out, CSS and fonts
 * loaded. Each as `<page>: <width> px wide at 375 px`, pages sorted. It opens the pages in the
 * machine's Chrome (`channel: 'chrome'`), or the one at $CHROME_PATH.
 */
export async function widePages(dist: string): Promise<string[]> {
  const site = await serve(dist);
  const executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch({
    ...(executablePath === undefined ? { channel: 'chrome' } : { executablePath }),
    // The pages are on 127.0.0.1: no proxy lookup (it can stall each load for seconds).
    args: ['--no-proxy-server'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: phoneWidth, height: 812 },
      deviceScaleFactor: 1,
    });
    const tab = await context.newPage();
    const wide: string[] = [];
    for (const file of htmlFiles(dist)) {
      const page = pageOf(file);
      await tab.goto(`${site.url}${page}`, { waitUntil: 'load' });
      await tab.evaluate(() => document.fonts.ready);
      const { scroll, client } = await tab.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      if (scroll > client) wide.push(`${page}: ${scroll} px wide at ${phoneWidth} px`);
    }
    return wide;
  } finally {
    await browser.close();
    site.close();
  }
}
