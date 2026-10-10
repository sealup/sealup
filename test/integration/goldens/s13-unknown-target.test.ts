// Golden S13, "Unknown target name" (CLI page, docs/exploration/assets/06/scenarios-problems.js).
// `sealup deploy prod`, exit 2: a typo in the target name. The output gives the right name ready
// to run and lists the names that exist. Names from this fixture (the page's own).
//
// Page form:
//   ✗ No target named prod in sealup.yml.
//     Did you mean production?  sealup deploy production
//     Targets in sealup.yml: production, staging.
//
//     Nothing was changed.
//     More: sealup.dev/e/unknown-target

import { describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  inGitHub,
  markdown,
  ref,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';

// Two targets, both reading the canary: their masks are the same lines, given once.
const config = [
  'upload: public_html',
  'targets:',
  ...['production', 'staging'].flatMap((name) => [
    `  ${name}:`,
    '    server: sftp://deploy@ssh.example.com:22/home/site',
    `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
  ]),
  '',
].join('\n');

const s13 = [
  '  {rb}✗{/} {b}No target named prod in sealup.yml.{/}',
  '    Did you mean production?  sealup deploy production',
  '    Targets in sealup.yml: production, staging.',
  '',
  '    Nothing was changed.',
  '    {d}More: sealup.dev/e/unknown-target{/}',
];

describe('S13: unknown target name', () => {
  const deploy = (tty: boolean, env = {}) => {
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    // No server: a run that connects fails the test.
    return runMain(['deploy', 'prod'], { cwd: project.root, tty, env });
  };

  it('prints the page lines in colour on a terminal and exits 2', async () => {
    const run = await deploy(true);
    expect(run.stderr).toBe(goldenText(s13, { color: true }));
    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(2);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', async () => {
    const run = await deploy(false);
    const s13log = ['sealup 0.0.0-source · deploy prod', ...s13];
    expect(run.stderr).toBe(goldenText(s13log, { color: false }));
    expect(run.exitCode).toBe(2);
  });

  // The GitHub form (page S13 `ci`): the masks, the version line, the same words, then the
  // annotation, which names the action's target input as the other place to fix.
  it('prints the GitHub form: masks, the same words, one annotation', async () => {
    const run = await deploy(false, inGitHub);
    const s13github = [
      ...canaryMasks,
      'sealup 0.0.0-source · deploy prod',
      ...s13,
      "::error title=Unknown target prod::No target named prod in sealup.yml. Did you mean production? Targets: production, staging. Fix the action's target input or the command.",
    ];
    expect(run.stderr).toBe(goldenText(s13github, { color: true }));
    expect(run.exitCode).toBe(2);
  });

  // The job summary (page S13 `summary`; spec #24 decision 32): no target was chosen, so no
  // target table. The file ends with a line break, which the page's text leaves out.
  it('writes the job summary: the caution box with the fix', async () => {
    const run = await deploy(false, inGitHub);
    expect(run.summary).toBe(
      markdown([
        '### ❌ No target named prod: nothing was changed',
        '',
        '> [!CAUTION]',
        '> `sealup.yml` has no target `prod`. Targets: `production`, `staging`.',
        '>',
        '> **Fix:** did you mean `production`? Set `target: production` in the workflow, or run `sealup deploy production`.',
        '',
        summaryFooter('unknown-target'),
      ]),
    );
  });
});
