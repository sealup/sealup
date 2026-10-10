// Golden S14, "Variable not set" (CLI page, docs/exploration/assets/06/scenarios-problems.js).
// `sealup deploy production`, exit 2: sealup.yml reads the password from PROD_PASSWORD and
// nothing provides it. On a laptop the fix is a line in sealup.env; in GitHub it takes two steps
// (the secret, and passing it under env:), and the output names both. The line is this
// fixture's (5; the page's config has it on 16).
//
// Page form:
//   ✗ PROD_PASSWORD is not set.
//     targets.production.password (sealup.yml line 16) reads ${PROD_PASSWORD}.
//     sealup looked in the environment and in sealup.env.
//     Add this line to sealup.env, next to sealup.yml:  PROD_PASSWORD=…
//
//     sealup did not connect. Nothing was changed on production.
//     More: sealup.dev/e/variable-not-set

import { describe, expect, it } from 'vitest';
import { goldenText } from '../../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  markdown,
  productionConfig,
  ref,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';

const reads = `    targets.production.password (sealup.yml line 5) reads ${ref('PROD_PASSWORD')}.`;
const state = [
  '',
  '    sealup did not connect. Nothing was changed on production.',
  '    {d}More: sealup.dev/e/variable-not-set{/}',
];

const s14 = [
  '  {rb}✗{/} {b}PROD_PASSWORD is not set.{/}',
  reads,
  '    sealup looked in the environment and in sealup.env.',
  '    Add this line to sealup.env, next to sealup.yml:  PROD_PASSWORD=…',
  ...state,
];

// The GitHub form (page S14 `ci`): no secret was resolved, so no mask; "empty or not set", since
// GitHub passes an empty value for a secret that does not exist and sealup reads empty as not
// set; the two steps; then the annotation at the password's line.
const secretRef = `$\{{ secrets.PROD_PASSWORD }}`;
const s14github = [
  'sealup 0.0.0-source · deploy production',
  '  {rb}✗{/} {b}PROD_PASSWORD is empty or not set.{/}',
  reads,
  '    In GitHub Actions a secret reaches sealup only through env: on its step.',
  '    1. Add the secret PROD_PASSWORD in the repository settings',
  '       (Secrets and variables › Actions) or in the production environment.',
  '    2. Pass it under env: of the sealup step:',
  `         PROD_PASSWORD: ${secretRef}`,
  ...state,
  `::error file=sealup.yml,line=5,title=PROD_PASSWORD is not set::targets.production.password reads ${ref('PROD_PASSWORD')}, and the sealup step did not get it. Add the secret PROD_PASSWORD (repository or production environment), then pass it under env: of the step: PROD_PASSWORD: ${secretRef}`,
];

describe('S14: variable not set', () => {
  const deploy = (tty: boolean, env: Record<string, string> = {}) => {
    const project = createProject(productionConfig(), {
      'public_html/index.html': '<h1>home</h1>',
    });
    // No server: a run that connects fails the test.
    return runMain(['deploy', 'production'], { cwd: project.root, tty, env });
  };

  it('prints the page lines in colour on a terminal and exits 2', async () => {
    const run = await deploy(true);
    expect(run.stderr).toBe(goldenText(s14, { color: true }));
    expect(run.exitCode).toBe(2);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', async () => {
    const run = await deploy(false);
    const s14log = ['sealup 0.0.0-source · deploy production', ...s14];
    expect(run.stderr).toBe(goldenText(s14log, { color: false }));
    expect(run.exitCode).toBe(2);
  });

  it('prints the GitHub form: the two steps, one annotation at the line', async () => {
    const run = await deploy(false, { ...inGitHub, PROD_PASSWORD: '' });
    expect(run.stderr).toBe(goldenText(s14github, { color: true }));
    expect(run.exitCode).toBe(2);
  });

  // The job summary (page S14 `summary`; spec #24 decision 32): the caution box with the two
  // steps. The page then shows the target table; here the target did not resolve (its password
  // is missing), so sealup has no target to show and the table is left out.
  it('writes the job summary: the caution box with the secret to add and pass', async () => {
    const run = await deploy(false, { ...inGitHub, PROD_PASSWORD: '' });
    expect(run.summary).toBe(
      markdown([
        '### ❌ PROD_PASSWORD is not set: nothing was changed on production',
        '',
        '> [!CAUTION]',
        `> \`targets.production.password\` (sealup.yml line 5) reads \`${ref('PROD_PASSWORD')}\`, and the sealup step did not get it.`,
        '>',
        '> **Fix:** add the secret `PROD_PASSWORD` (repository settings, or the `production` environment), then pass it under `env:` of the sealup step:',
        '>',
        '> ```yaml',
        `> PROD_PASSWORD: ${secretRef}`,
        '> ```',
        '',
        summaryFooter('variable-not-set'),
      ]),
    );
  });
});
