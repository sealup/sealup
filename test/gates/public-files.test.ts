// The public repo's own files (spec #41 decision 39; exploration 05 §2): what a visitor, a
// contributor or a security researcher finds on day one, read as GitHub and npm read them.
// actionlint, zizmor and the workflow gate check the workflows themselves (workflows.test.ts, CI).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../../scripts/gates.ts';

const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
const yamlOf = (path: string): unknown => parse(read(path));

interface Update {
  readonly 'package-ecosystem': string;
  readonly directory: string;
  readonly schedule: { readonly interval: string };
  readonly cooldown?: { readonly 'default-days'?: number };
  readonly groups?: Record<string, { readonly patterns?: readonly string[] }>;
  readonly ignore?: readonly {
    readonly 'dependency-name': string;
    readonly 'update-types'?: readonly string[];
  }[];
}

describe('Dependabot (R25)', () => {
  const updates = (yamlOf('.github/dependabot.yml') as { updates: readonly Update[] }).updates;

  it('updates the CLI, site and Actions, each in one grouped PR, after 7 days of cooldown', () => {
    expect(updates.map((u) => [u['package-ecosystem'], u.directory]).sort()).toEqual([
      ['github-actions', '/'],
      ['npm', '/'],
      ['npm', '/site'],
    ]);
    for (const update of updates) {
      expect(update.cooldown?.['default-days']).toBe(7);
      const groups = Object.values(update.groups ?? {});
      expect(groups.map((group) => group.patterns)).toEqual([['*']]);
    }
  });

  // Node's types follow the oldest Node sealup supports (engines), not the newest: a major bump
  // would let the code use APIs that Node 24 lacks, with every check still green.
  it("keeps @types/node on the oldest supported Node's major", () => {
    const pkg = JSON.parse(read('package.json')) as {
      engines: { node: string };
      devDependencies: Record<string, string>;
    };
    const oldest = /^>=(\d+)$/.exec(pkg.engines.node)?.[1];
    expect(pkg.devDependencies['@types/node']?.split('.')[0]).toBe(oldest);
    const npm = updates.find((u) => u['package-ecosystem'] === 'npm');
    expect(npm?.ignore).toContainEqual({
      'dependency-name': '@types/node',
      'update-types': ['version-update:semver-major'],
    });
  });
});

/** A Markdown file's `##` headings, in order. */
const headings = (path: string): string[] =>
  [...read(path).matchAll(/^## (.+)$/gm)].map((match) => match[1] ?? '');

/** The wordmark as the site serves it (site/src/pages/brand/). */
const wordmark = {
  light: 'https://sealup.dev/brand/sealup-wordmark.svg',
  dark: 'https://sealup.dev/brand/sealup-wordmark-on-dark.svg',
};

/** The README's badges, in order: where each links, its image, its text. */
const badges = [
  {
    href: 'https://github.com/sealup/sealup/actions/workflows/ci.yml',
    image: 'https://github.com/sealup/sealup/actions/workflows/ci.yml/badge.svg',
    alt: 'CI',
  },
  {
    href: 'https://www.npmjs.com/package/sealup',
    image: 'https://img.shields.io/npm/v/sealup',
    alt: 'npm version',
  },
  {
    href: 'https://scorecard.dev/viewer/?uri=github.com/sealup/sealup',
    image: 'https://api.scorecard.dev/projects/github.com/sealup/sealup/badge',
    alt: 'OpenSSF Scorecard',
  },
  {
    href: 'https://github.com/sealup/sealup/blob/main/LICENSE',
    image: 'https://img.shields.io/badge/licence-MIT-blue',
    alt: 'Licence: MIT',
  },
];

describe('README (exploration 05 §2)', () => {
  const readme = read('README.md');

  it("has exploration 05's sections, in its order", () => {
    expect(headings('README.md')).toEqual([
      'Why',
      'Quick start',
      'Config',
      'Where it runs',
      'How releases are made',
      'Links',
    ]);
  });

  it('says what sealup does in one sentence (story 85)', () => {
    const pitch = readme.split('\n').find((line) => line.startsWith('**')) ?? '';
    expect(pitch.match(/[.!?](\s|$)/g)).toHaveLength(1);
  });

  it('shows the S07 run as text, as sealup prints it in that golden, with no image (I-095)', () => {
    const intro = readme.slice(0, readme.indexOf('\n## '));
    const block = /```text\n\$ npx sealup deploy production\n([\s\S]*?)\n```/.exec(intro)?.[1];
    // The golden's expected lines, as its string literals give them, colour tokens dropped.
    const golden = read('test/integration/goldens/s07-first-deploy.test.ts');
    const printed = new Set(
      [...golden.matchAll(/^\s*'(.*)',$/gm)].map(([, line]) =>
        (line ?? '').replace(/\{[a-z]*\}|\{\/\}/g, ''),
      ),
    );
    const lines = (block ?? '').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(printed, line).toContain(line);
    // The only images are the wordmark and the badges (spec #88 decisions 27, 28).
    expect(readme).not.toMatch(/!\[|\.gif\b/i);
    expect([...readme.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => src)).toEqual([
      wordmark.light,
      ...badges.map((badge) => badge.image),
    ]);
  });

  // npm shows only absolute images, and never the <picture>'s <source>: its <img> is the light
  // wordmark. GitHub's dark mode takes the dark one (spec #88 decision 27).
  it('opens with the wordmark, served by sealup.dev, dark on GitHub in dark mode', () => {
    const top = readme.slice(0, readme.indexOf('**'));
    expect(top).toContain(
      `<source media="(prefers-color-scheme: dark)" srcset="${wordmark.dark}">`,
    );
    expect(top).toMatch(new RegExp(`<img src="${wordmark.light}" alt="sealup"`));
    expect(top.indexOf('<picture>')).toBeLessThan(top.indexOf('<source'));
    expect(top.indexOf('<img')).toBeLessThan(top.indexOf('</picture>'));
  });

  it('shows the badges under it, each linked to its source, no download count', () => {
    const top = readme.slice(0, readme.indexOf('**'));
    const linked = [...top.matchAll(/<a href="([^"]+)"><img src="([^"]+)" alt="([^"]+)"/g)];
    expect(linked.map(([, href, image, alt]) => ({ href, image, alt }))).toEqual(badges);
    expect(top.indexOf('</picture>')).toBeLessThan(top.indexOf('<a href='));
    expect(top).not.toMatch(/download|\/npm\/d[wmyt]\//i);
  });

  it('says on the write: line of its config what write: does (spec #88 decision 31)', () => {
    const line = readme.split('\n').find((text) => text.startsWith('write:')) ?? '';
    expect(line).toMatch(/^write: +# .*\bserver\b.*\bdeploy\b/);
  });

  // Decision 0043: by its version tag, between release-please's version markers.
  it('gives the action by its version, the npx command and the verify commands', () => {
    const marked =
      /<!-- x-release-please-start-version -->\n([\s\S]*?)<!-- x-release-please-end -->/;
    expect(marked.exec(readme)?.[1]).toMatch(
      /^- uses: sealup\/sealup@v\d+\.\d+\.\d+\n {2}id: sealup\n/m,
    );
    expect(readme).not.toMatch(/sealup\/sealup@(?!v\d)/);
    expect(readme).toContain('npx sealup init');
    expect(readme).toContain('gh attestation verify');
    expect(readme).toContain('npm audit signatures');
  });

  // vision.md, which stays private, is held to it in test/private/vision.test.ts.
  it("follows the owner's round 2 note: no clients who already pay (README, npm)", () => {
    const description = (JSON.parse(read('package.json')) as { description: string }).description;
    for (const text of [readme, description]) {
      expect(text).not.toMatch(/clients? already pays? for/);
    }
  });
});

describe('SECURITY.md, CONTRIBUTING.md and the code of conduct', () => {
  it('SECURITY.md follows exploration 03 §8, vsftpd among the known limits', () => {
    expect(headings('SECURITY.md')).toEqual([
      'Supported versions',
      'Reporting a vulnerability',
      'What sealup protects',
      'How sealup keeps your credentials safe',
      'How sealup protects your files',
      'How sealup ships',
      'What you should do',
      'Known limits',
    ]);
    const limits = read('SECURITY.md').split('## Known limits')[1] ?? '';
    expect(limits).toContain('vsftpd');
    expect(read('SECURITY.md')).toContain(
      'https://github.com/sealup/sealup/security/advisories/new',
    );
  });

  it('SECURITY.md verifies both attested assets: the npm tarball and action.mjs', () => {
    expect(read('SECURITY.md')).toMatch(/^gh attestation verify sealup-[\d.]+\.tgz --repo /m);
    expect(read('SECURITY.md')).toMatch(/^gh attestation verify action\.mjs --repo /m);
  });

  it('CONTRIBUTING.md covers the build, the tests, the commits, large PRs and the port back', () => {
    expect(headings('CONTRIBUTING.md')).toEqual([
      'Build and test',
      'Commits',
      'Before a large pull request',
      'What happens to your pull request',
    ]);
  });

  it('the code of conduct is the Contributor Covenant 3.0', () => {
    expect(read('CODE_OF_CONDUCT.md')).toMatch(/Contributor Covenant[^\n]*version 3\.0/i);
  });
});

interface FormField {
  readonly type: string;
  readonly id?: string;
  readonly validations?: { readonly required?: boolean };
}

describe('issue forms and the PR template', () => {
  const form = (name: string) =>
    yamlOf(`.github/ISSUE_TEMPLATE/${name}.yml`) as { name: string; body: readonly FormField[] };

  it('turns blank issues off and points security reports to private reporting', () => {
    const config = yamlOf('.github/ISSUE_TEMPLATE/config.yml') as {
      blank_issues_enabled: boolean;
      contact_links: readonly { url: string }[];
    };
    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links.map((link) => link.url)).toContain(
      'https://github.com/sealup/sealup/security/advisories/new',
    );
  });

  it('asks a bug for what reproduces it, each answer required but the config and output', () => {
    const fields = form('bug').body.filter((field) => field.type !== 'markdown');
    expect(fields.map((field) => field.id)).toEqual([
      'what-happened',
      'version',
      'os',
      'where',
      'protocol',
      'host',
      'config',
      'dry-run',
    ]);
    const required = fields.filter((field) => field.validations?.required === true);
    expect(required.map((field) => field.id)).toEqual([
      'what-happened',
      'version',
      'os',
      'where',
      'protocol',
      'host',
    ]);
  });

  it('has a feature form and a short PR template', () => {
    expect(form('feature').body.some((field) => field.type === 'textarea')).toBe(true);
    const template = read('.github/pull_request_template.md');
    expect(template.split('\n').length).toBeLessThanOrEqual(20);
    expect(template).toMatch(/no secrets?/i);
  });
});

describe('Scorecard (I-045)', () => {
  const workflow = yamlOf('.github/workflows/scorecard.yml') as {
    on: { schedule?: readonly { cron: string }[] };
    jobs: Record<string, { if?: string; steps: readonly { uses?: string }[] }>;
  };

  it('runs every week, on a cron of one day of the week', () => {
    const crons = (workflow.on.schedule ?? []).map((entry) => entry.cron.split(' '));
    expect(crons).toHaveLength(1);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = crons[0] ?? [];
    expect([minute, hour].every((field) => /^\d+$/.test(field ?? ''))).toBe(true);
    expect([dayOfMonth, month]).toEqual(['*', '*']);
    expect(dayOfWeek).toMatch(/^[0-6]$/);
  });

  it("runs OpenSSF's Scorecard action", () => {
    const uses = Object.values(workflow.jobs).flatMap((job) => job.steps.map((s) => s.uses));
    expect(uses.some((step) => step?.startsWith('ossf/scorecard-action@'))).toBe(true);
  });

  // The private repo's GITHUB_TOKEN cannot run Scorecard's GraphQL commit query, and a
  // private repo cannot publish; only the public repo's results feed the badge.
  it('runs only in the public repo', () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("github.repository == 'sealup/sealup'");
    }
  });
});
