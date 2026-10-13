// The public tree (decision 0035): turns the private repo's file list into the public one. A pure
// module (no Node built-in): the caller lists the files and reads them; scripts/export-public.ts
// is that caller.
//
// Three steps, and any problem in any of them stops the export:
//   1. an allow-list of paths: only what is listed below is public;
//   2. a check of the public CHANGELOG.md: its newest section is the version being released, and
//      it links to no repo but the public one (decision 0042);
//   3. a scan of each kept file, its path and its content, for denied strings.
//
// Changing a list below changes what is public: do it in the open, in its own commit.

/** Folders whose whole content is public. */
const publicFolders = [
  'src/',
  'test/',
  'scripts/',
  'site/',
  '.githooks/',
  '.github/ISSUE_TEMPLATE/',
];

/** Single public files: the action, the package and tool configs, the public `.github` files. */
const publicFiles = new Set([
  'action.yml',
  'dist/action.mjs',
  'schema.json',
  'LICENSE',
  'package.json',
  'package-lock.json',
  '.npmrc',
  'tsconfig.json',
  'biome.json',
  'knip.json',
  'vitest.config.ts',
  '.gitignore',
  '.gitattributes',
  '.github/dependabot.yml',
  '.github/pull_request_template.md',
]);

/**
 * Folders inside a public folder that stay private: the tests of files the export leaves out
 * (release-please's config, the private workflows, the notes). The public repo's own checks
 * (its release.yml) run without them, and without the files they read.
 */
const privateFolders = ['test/private/'];

/** Root `.md` files that stay private: the agents' rules. */
const privateRootMarkdown = new Set(['AGENTS.md', 'CLAUDE.md']);

/** Every workflow is in one of the two lists; a workflow in neither stops the export. */
const publicWorkflows = new Set([
  'ci.yml',
  'self-test.yml',
  'release.yml',
  'pages.yml',
  'scorecard.yml',
  'codeql.yml',
]);
const privateWorkflows = new Set(['public-sync.yml', 'release-please.yml']);

const workflowFolder = '.github/workflows/';

/** The kinds of denied string. A hit names its kind, never the string it matched. */
type DeniedKind = 'ovh-cluster-host' | 'bench-folder' | 'local-drive-path' | 'private-name';

interface DeniedPattern {
  readonly kind: DeniedKind;
  /** Global and sticky-free, so `matchAll` finds every hit. */
  readonly pattern: RegExp;
}

/**
 * The built-in kinds. Each pattern is written so this file never matches it: the export scans
 * `scripts/` too.
 */
const builtIn: readonly DeniedPattern[] = [
  // A numbered OVH cluster (`ssh.cluster` + digits + `.hosting.ovh.net`); `clusterXXX` passes.
  { kind: 'ovh-cluster-host', pattern: /cluster\d{2,3}(?![\w])/gi },
  // The owner's bench folder on the real hosts.
  { kind: 'bench-folder', pattern: /deploy[-_]bench/gi },
  // A local drive path: a drive and `Users` or `workspaces`, any path on the owner's `H:` drive,
  // with `\`, `\\` (JSON-escaped) or `/`, and the Git Bash forms (a drive letter between two
  // slashes, then `Users` or `workspaces`).
  {
    kind: 'local-drive-path',
    pattern:
      /(?<![\w])(?:[a-z]:(?:\\{1,2}|\/)(?:users|workspaces)(?![\w])|h:(?:\\{1,2}|\/)|\/[a-z]\/(?:users|workspaces)\/)/gi,
  },
];

/**
 * The proven-to-bite fixtures (test/gates/export.test.ts) hold the built-in kinds on purpose,
 * with synthetic values; in this folder the tree scan looks for private names only.
 */
const fixtureFolder = 'test/gates/bad/export/';

/**
 * The names list the owner keeps, git-ignored: client names and the owner's other projects,
 * names only, never secrets. One name per line; a line starting with `#` is a comment; blank
 * lines are skipped; spaces around a name are dropped.
 */
export function parseNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

const asLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * A name matches case-insensitively, as a whole word, with one space, `-`, `_` or `.` between
 * its words, or none: "Acme Bakery" finds `acme-bakery.example` and `acmebakery`.
 */
function namePattern(name: string): DeniedPattern | undefined {
  const words = name.split(/[\s._-]+/).filter((word) => word !== '');
  if (words.length === 0) return undefined;
  const body = words.map(asLiteral).join('[\\s._-]?');
  return {
    kind: 'private-name',
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu'),
  };
}

export interface ExportInput {
  /** The private repo's files, relative to its root, with `/` separators. */
  readonly paths: readonly string[];
  /** The content of one of `paths`. */
  readonly read: (path: string) => string;
  /** The names list (see `parseNames`); undefined when the owner's file is absent. */
  readonly names?: readonly string[] | undefined;
  /** A release export: the names list must be there, with at least one name. */
  readonly release?: boolean | undefined;
}

/** One denied string in one public file. */
interface Hit {
  readonly path: string;
  /** 1-based; 0 when the hit is in the path itself. */
  readonly line: number;
  /** 1-based, in the line (or in the path). */
  readonly column: number;
  readonly kind: DeniedKind;
}

export interface PublicTree {
  /** True when the tree may be published: no error and no hit. */
  readonly ok: boolean;
  /** The public files, sorted. */
  readonly files: readonly string[];
  /** The denied strings found, in file order. */
  readonly hits: readonly Hit[];
  /** Problems that stop the export, one line each: the names list, unlisted workflows, hits. */
  readonly errors: readonly string[];
  /** What the export did not check, without stopping it. */
  readonly notes: readonly string[];
}

/** The hits of the patterns in one text: a path (line 0) or a file's content. */
function scanText(
  path: string,
  text: string,
  patterns: readonly DeniedPattern[],
  asPath: boolean,
): Hit[] {
  const hits: Hit[] = [];
  const lines = asPath ? [text] : text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { kind, pattern } of patterns) {
      for (const match of line.matchAll(pattern)) {
        hits.push({ path, line: asPath ? 0 : index + 1, column: match.index + 1, kind });
      }
    }
  });
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

const describeHit = (hit: Hit): string =>
  hit.line === 0
    ? `${hit.path}: the path holds ${hit.kind}`
    : `${hit.path}:${hit.line}:${hit.column} ${hit.kind}`;

type Verdict = 'public' | 'private' | 'unlisted-workflow';

function classify(path: string): Verdict {
  if (path.startsWith(workflowFolder)) {
    const name = path.slice(workflowFolder.length);
    if (publicWorkflows.has(name)) return 'public';
    if (privateWorkflows.has(name)) return 'private';
    return /\.ya?ml$/.test(name) && !name.includes('/') ? 'unlisted-workflow' : 'private';
  }
  if (publicFiles.has(path)) return 'public';
  if (privateFolders.some((folder) => path.startsWith(folder))) return 'private';
  if (publicFolders.some((folder) => path.startsWith(folder))) return 'public';
  if (!path.includes('/') && path.endsWith('.md') && !privateRootMarkdown.has(path)) {
    return 'public';
  }
  return 'private';
}

/** What the names list adds to the scan, and what the export says about it. */
function nameCheck(input: ExportInput): {
  patterns: DeniedPattern[];
  errors: string[];
  notes: string[];
} {
  if (input.names === undefined) {
    return input.release === true
      ? {
          patterns: [],
          errors: ["No names list: a release checks client names and the owner's other projects."],
          notes: [],
        }
      : {
          patterns: [],
          errors: [],
          notes: ["No names list: client names and the owner's other projects were not checked."],
        };
  }
  const patterns = input.names.flatMap((name) => namePattern(name) ?? []);
  const empty = input.release === true && patterns.length === 0;
  return {
    patterns,
    errors: empty ? ['The names list is empty: a release checks at least one name.'] : [],
    notes: [],
  };
}

/**
 * The public changelog (decision 0042): `CHANGELOG.md` is written for the public repo, by hand at
 * each release; release-please's full changelog stays private. Its newest section must be
 * package.json's version, and its GitHub links must point at the public repo. Checked when the
 * tree holds both files.
 */
function changelogErrors(input: ExportInput, files: readonly string[]): string[] {
  if (!files.includes('CHANGELOG.md') || !files.includes('package.json')) return [];
  let version: unknown;
  try {
    version = (JSON.parse(input.read('package.json')) as { version?: unknown }).version;
  } catch {
    return ['package.json: not JSON, so CHANGELOG.md cannot be checked against its version'];
  }
  const errors: string[] = [];
  const lines = input.read('CHANGELOG.md').split(/\r?\n/);
  // A release heading, as release-please and the hand-written sections spell it:
  // `## [0.2.0](…compare…) (date)` or `## 0.1.0 (date)`.
  const newest = lines
    .map((line) => /^## \[?(\d+\.\d+\.\d+)\]?(?:[ (]|$)/.exec(line)?.[1])
    .find((found) => found !== undefined);
  if (newest !== version) {
    errors.push(
      `CHANGELOG.md: its newest section is ${newest ?? 'missing'}, not package.json's ${String(version)}; write ${String(version)}'s section first`,
    );
  }
  lines.forEach((line, index) => {
    // A repo name ends before a dot that ends the sentence; `.git` names the same repo.
    for (const match of line.matchAll(/github\.com\/sealup\/([\w-]+(?:\.[\w-]+)*)/gi)) {
      if (match[1]?.toLowerCase().replace(/\.git$/, '') !== 'sealup') {
        errors.push(
          `CHANGELOG.md:${index + 1}:${match.index + 1} links to a repo other than sealup/sealup`,
        );
      }
    }
  });
  return errors;
}

/** The public tree of the private repo's files. */
export function publicTree(input: ExportInput): PublicTree {
  const files: string[] = [];
  const errors: string[] = [];
  for (const path of [...input.paths].sort()) {
    const verdict = classify(path);
    if (verdict === 'public') files.push(path);
    else if (verdict === 'unlisted-workflow') {
      errors.push(
        `${path}: a workflow in neither list; name it public or private in scripts/public-tree.ts`,
      );
    }
  }
  errors.push(...changelogErrors(input, files));
  return scan(input, files, errors, true);
}

/**
 * Whether a change to these paths (added, changed or deleted) can change the export: one of them
 * is public, or is a workflow in neither list (which stops the export). The paths alone decide.
 */
export function touchesPublicTree(paths: readonly string[]): boolean {
  return paths.some((path) => classify(path) !== 'private');
}

/**
 * Scans every given file as it is: no allow-list, and no excuse for the proven-to-bite fixtures
 * (they must each fail here).
 */
export function scanFiles(input: ExportInput): PublicTree {
  return scan(input, [...input.paths].sort(), [], false);
}

function scan(
  input: ExportInput,
  files: readonly string[],
  earlier: readonly string[],
  excuseFixtures: boolean,
): PublicTree {
  const names = nameCheck(input);
  const all = [...builtIn, ...names.patterns];
  const hits = files.flatMap((path) => {
    const patterns = excuseFixtures && path.startsWith(fixtureFolder) ? names.patterns : all;
    return [
      ...scanText(path, path, patterns, true),
      ...scanText(path, input.read(path), patterns, false),
    ];
  });
  const errors = [...names.errors, ...earlier, ...hits.map(describeHit)];
  return { ok: errors.length === 0, files, hits, errors, notes: names.notes };
}
