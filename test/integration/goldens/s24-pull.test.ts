// Golden S24, "sealup pull" (CLI page, docs/exploration/assets/06/scenarios-problems.js).
// `sealup pull production` on a terminal, exit 0: the users' uploads come down from production
// into public_html/resources (spec #24 decision 25). The server on the left, what is new and what
// is already here, once that local files are never deleted, a `↓` progress line, the result.
//
// Adapted: the fixture's files (2 new, 2 already here, 5 KB) instead of the page's 1,284 new,
// 6,240 already here and 312 MB; the time with its decimal (`42.0 s`), as every result line here
// (the page's `42 s` is the mockup's rounding).
//
// Page form:
//   production  sftp://deploy@ssh.example.com:22/home/site
//   host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
//
//   Pull  www/resources → public_html/resources
//   1,284 new files · 6,240 already here (same size and date)       312 MB
//   Local files are never deleted.
//   ↓ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   1,284 / 1,284 files   312 / 312 MB   40.0 s
//   ✓ Pulled 1,284 files from production in 42 s.
//     312 MB · into public_html/resources

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createMemoryServer,
  goldenText,
  screenOf,
  steppedClock,
} from '../../../src/testkit/index.ts';
import { hostKeyFingerprint, pullProject, runMain } from '../../deploy-kit.ts';

const s24 = [
  '  production  sftp://deploy@ssh.example.com:22/home/site',
  `  host key    ${hostKeyFingerprint}  {g}verified{/}`,
  '',
  '  {b}Pull{/}  www/resources → public_html/resources',
  `  2 new files · 2 already here (same size and date)${' '.repeat(17)}5 KB`,
  '  {d}Local files are never deleted.{/}',
  '  {gb}✓ Pulled{/} 2 files from production in 42.0 s.',
  '    {d}5 KB · into public_html/resources{/}',
];

describe('S24: sealup pull', () => {
  it('prints the page lines on a terminal and copies the new files here, dated as on the server', async () => {
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const project = pullProject(server);
    const run = await runMain(['pull', 'production'], {
      cwd: project.root,
      tty: true,
      server,
      clock: steppedClock(0, 42_000),
    });
    expect(screenOf(run.stderr)).toBe(goldenText(s24, { color: true }));
    expect(run.exitCode).toBe(0);
    // The progress line was drawn, with the pull's arrow, then erased by the result.
    expect(run.stderr).toContain('↓');

    const local = (path: string) =>
      join(project.root, 'public_html', 'resources', ...path.split('/'));
    expect(readFileSync(local('2024/01/photo-1.jpg'))).toEqual(
      Buffer.from(project.served['2024/01/photo-1.jpg'] ?? []),
    );
    expect(Math.floor(statSync(local('2024/01/photo-1.jpg')).mtimeMs / 1000)).toBe(project.mtime);
    expect(Math.floor(statSync(local('2024/01/photo-2.jpg')).mtimeMs / 1000)).toBe(project.mtime);
  });
});
