// The workflow rules (decision 0017, R26), checked without network or extra tools so they run in
// `npm run check`. actionlint and zizmor check much more in CI; this script keeps the three
// rules that matter most from slipping in between two CI runs.
//
//   node scripts/check-workflows.ts [file...]   default: every .yml/.yaml in .github/workflows/
//
// Rules, each with an id printed on the violation line:
//   unpinned             `uses:` names a full 40-character commit SHA (a local `./` action and a
//                        `docker://…@sha256:` image are fine)
//   permissions          the workflow sets top-level `permissions:` to exactly `contents: read`,
//                        and nothing grants `write` but a job the write table lists, or asks
//                        it for a GitHub App token but a job the App-token table lists
//   pull-request-target  the pull_request_target trigger is never used
//
// It reads YAML line by line (no YAML library in the dev tools): enough for these rules on
// workflows written in block style, which is all this repo uses.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { repoRoot } from './gates.ts';

/**
 * The write table (spec #41 decisions 37 and 39, R26): the only `write` permissions any workflow may
 * grant, by workflow file and job, each in that job's own `permissions:` block. A new write is a
 * change to this table, so it shows in review. `public-sync.yml` is listed with no writes: it
 * pushes with the GitHub App's token, never the workflow's.
 */
const writeTable: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // `pages` calls pages.yml after the release: a called workflow gets no more than its caller's
  // job grants, so it repeats pages.yml's `deploy` row.
  'release.yml': {
    release: ['contents', 'id-token', 'attestations'],
    pages: ['pages', 'id-token'],
  },
  'pages.yml': { deploy: ['pages', 'id-token'] },
  'release-please.yml': { 'release-please': ['contents', 'pull-requests'] },
  'public-sync.yml': {},
  // Scorecard publishes its results to the OpenSSF API (the badge) with an OIDC token (spec #41
  // decision 39). No `security-events`: code scanning upload stays off.
  'scorecard.yml': { analysis: ['id-token'] },
  // CodeQL uploads public source analysis, without write access to repository contents.
  'codeql.yml': { analyze: ['security-events'] },
};

/**
 * The App-token table (spec #41 decision 35): the only `permission-<scope>: write` inputs a step
 * may give (actions/create-github-app-token's way to narrow a GitHub App token below the App's
 * own permissions), by workflow file and job. public-sync pushes the release commit and its tag
 * to the public repo, workflows included, so it asks contents and workflows; nothing else.
 */
const appTokenTable: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'public-sync.yml': { sync: ['contents', 'workflows'] },
};

interface Violation {
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const pinned = /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const pinnedImage = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

/** The line without its comment (a `#` at the start or after a space, outside quotes). */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/** Why a line granting `write` breaks the rule, or undefined when the write table allows it. */
function writeViolation(workflow: string, keys: readonly string[]): string | undefined {
  const [root, job, block, scope] = keys;
  if (root === 'permissions') {
    return 'the top level grants write: only a job the write table lists may write';
  }
  if (root === 'jobs' && job !== undefined && block === 'permissions' && keys.length === 4) {
    if (scope !== undefined && writeTable[workflow]?.[job]?.includes(scope) === true) return;
    return `job "${job}" of ${workflow} grants "${scope}: write", which the write table does not list`;
  }
  const input = keys.at(-1) ?? '';
  if (root === 'jobs' && job !== undefined && block === 'steps' && keys[3] === 'with') {
    if (keys.length === 5 && input.startsWith('permission-')) {
      const asked = input.slice('permission-'.length);
      if (appTokenTable[workflow]?.[job]?.includes(asked) === true) return;
      return `job "${job}" of ${workflow} asks an App token for "${asked}: write", which the App-token table does not list`;
    }
  }
  return 'a permission grants write';
}

function checkWorkflow(text: string, workflow: string): Violation[] {
  const lines = text.split(/\r?\n/).map(stripComment);
  const violations: Violation[] = [];
  let topLevelPermissions: number | undefined;
  /** The mapping keys that lead to the current line, with their indents. */
  const keys: { indent: number; key: string }[] = [];

  lines.forEach((line, index) => {
    const number = index + 1;
    const key = /^(\s*)(-\s+)?([\w-]+):(?:\s|$)/.exec(line);
    if (key?.[3] !== undefined) {
      const indent = (key[1]?.length ?? 0) + (key[2]?.length ?? 0);
      while ((keys.at(-1)?.indent ?? -1) >= indent) keys.pop();
      keys.push({ indent, key: key[3] });
    }
    const uses = /^\s*(?:-\s+)?uses:\s*(.+)$/.exec(line);
    if (uses?.[1] !== undefined) {
      const target = unquote(uses[1]);
      if (!target.startsWith('./') && !pinned.test(target) && !pinnedImage.test(target)) {
        violations.push({
          line: number,
          rule: 'unpinned',
          message: `"${target}" is not pinned to a full commit SHA`,
        });
      }
    }
    if (/\bpull_request_target\b/.test(line)) {
      violations.push({
        line: number,
        rule: 'pull-request-target',
        message: 'pull_request_target runs untrusted code with secrets; use pull_request',
      });
    }
    if (/\bwrite-all\b/.test(line)) {
      violations.push({
        line: number,
        rule: 'permissions',
        message: 'write-all grants every write',
      });
    } else if (/:\s*write\s*(?:[,}]|$)/.test(line)) {
      // A flow mapping (`{ contents: write }`) never matches a key path, so it always fails.
      const blockStyle = key !== null && /:\s*write$/.test(line);
      const why = writeViolation(workflow, blockStyle ? keys.map((k) => k.key) : []);
      if (why !== undefined) violations.push({ line: number, rule: 'permissions', message: why });
    }
    if (/^permissions:/.test(line)) topLevelPermissions = index;
  });

  if (topLevelPermissions === undefined) {
    violations.push({
      line: 1,
      rule: 'permissions',
      message: 'no top-level permissions: set `permissions: contents: read`',
    });
  } else {
    const inline = (lines[topLevelPermissions] ?? '').replace(/^permissions:/, '').trim();
    const block: string[] = [];
    for (const line of lines.slice(topLevelPermissions + 1)) {
      if (line.trim() === '') continue;
      if (!/^\s/.test(line)) break;
      block.push(line.trim());
    }
    if (inline !== '' || block.join('\n') !== 'contents: read') {
      violations.push({
        line: topLevelPermissions + 1,
        rule: 'permissions',
        message: 'top-level permissions must be exactly `contents: read`',
      });
    }
  }
  return violations;
}

function defaultFiles(): string[] {
  const folder = join(repoRoot, '.github', 'workflows');
  return readdirSync(folder)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => join(folder, name));
}

const files = process.argv.length > 2 ? process.argv.slice(2) : defaultFiles();
let count = 0;
for (const file of files) {
  const name = relative(repoRoot, file).replaceAll('\\', '/');
  for (const v of checkWorkflow(readFileSync(file, 'utf8'), basename(file))) {
    console.error(`${name}:${v.line} ${v.rule}: ${v.message}`);
    count++;
  }
}
console.error(
  count === 0
    ? `workflows: ${files.length} file(s), all rules hold`
    : `workflows: ${count} violation(s)`,
);
process.exitCode = count === 0 ? 0 : 1;
