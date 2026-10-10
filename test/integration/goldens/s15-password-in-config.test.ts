// Golden S15, "Password written in the config" (CLI page, docs/exploration/assets/06/
// scenarios-problems.js). `sealup deploy production`, exit 2: the password itself is written in
// sealup.yml. sealup refuses before connecting, names the field and line but never the value,
// and says to change the password. The written password is the canary, so the leak check proves
// it is never printed; the line (5) and the variable it suggests (PRODUCTION_PASSWORD, from the
// target's name) are this fixture's, where the page has line 16 and PROD_PASSWORD.
//
// Page form:
//   ✗ sealup.yml holds a password: targets.production.password (line 16).
//     sealup takes passwords only from variables, so they stay out of git.
//     1. Move the value to sealup.env (git-ignored):  PROD_PASSWORD=…
//     2. Write this on line 16 instead:               password: ${PROD_PASSWORD}
//     3. If sealup.yml was ever committed, the password is in your git history:
//        change it with your host.
//
//     sealup did not connect. Nothing was changed on production.
//     More: sealup.dev/e/secret-in-config

import { describe, expect, it } from 'vitest';
import { canaries, goldenText } from '../../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  inGitHub,
  markdown,
  productionConfig,
  ref,
  runMain,
  summaryFooter,
} from '../../deploy-kit.ts';

// The canary as a YAML single-quoted string ('' is one ').
const written = `'${canaries.SEALUP_CANARY_PASSWORD.replaceAll("'", "''")}'`;
const variable = ref('PRODUCTION_PASSWORD');
const state = [
  '',
  '    sealup did not connect. Nothing was changed on production.',
  '    {d}More: sealup.dev/e/secret-in-config{/}',
];

const s15 = [
  '  {rb}✗{/} {b}sealup.yml holds a password: targets.production.password (line 5).{/}',
  '    sealup takes passwords only from variables, so they stay out of git.',
  '    1. Move the value to sealup.env (git-ignored):  PRODUCTION_PASSWORD=…',
  `    2. Write this on line 5 instead:                password: ${variable}`,
  '    3. If sealup.yml was ever committed, the password is in your git history:',
  '       change it with your host.',
  ...state,
];

// The GitHub form (page S15 `ci`): the written password's masks first, so even this run never
// prints it; the fix names a secret instead of sealup.env, and the history warning is no longer
// an "if"; then the annotation at the line. The first step's line passes 80 columns with this
// target's longer variable name (a name is never cut, decision 0024 §2).
const s15github = [
  ...canaryMasks,
  'sealup 0.0.0-source · deploy production',
  s15[0] ?? '',
  s15[1] ?? '',
  '    1. Add the secret PRODUCTION_PASSWORD (repository or environment settings) and',
  '       pass it under env: of the sealup step:',
  `         PRODUCTION_PASSWORD: $\{{ secrets.PRODUCTION_PASSWORD }}`,
  `    2. Write this on line 5 instead:  password: ${variable}`,
  '    3. This file is in your repository, so the password is in its history:',
  '       change it with your host.',
  ...state,
  `::error file=sealup.yml,line=5,title=Password written in sealup.yml::targets.production.password must be a variable such as ${variable}. Move the value to a secret, pass it under env: of the step, and change the password: it is in your git history.`,
];

describe('S15: password written in the config', () => {
  const deploy = (tty: boolean, env = {}) => {
    const config = productionConfig().replace(ref('PROD_PASSWORD'), written);
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    // No server: a run that connects fails the test.
    return runMain(['deploy', 'production'], { cwd: project.root, tty, env });
  };

  it('prints the page lines in colour on a terminal and exits 2', async () => {
    const run = await deploy(true);
    expect(run.stderr).toBe(goldenText(s15, { color: true }));
    expect(run.exitCode).toBe(2);
  });

  it('prints the log form without colour when not a terminal (spec #24 decision 27)', async () => {
    const run = await deploy(false);
    const s15log = ['sealup 0.0.0-source · deploy production', ...s15];
    expect(run.stderr).toBe(goldenText(s15log, { color: false }));
    expect(run.exitCode).toBe(2);
  });

  it('prints the GitHub form: the password masked first, a secret as the fix', async () => {
    const run = await deploy(false, inGitHub);
    expect(run.stderr).toBe(goldenText(s15github, { color: true }));
    expect(run.exitCode).toBe(2);
  });

  // The job summary (page S15 `summary`; spec #24 decision 32): the three steps, the last in
  // bold. The page then shows the target table; here sealup.yml did not load (it holds a
  // password), so sealup has no target to show and the table is left out.
  it('writes the job summary: the three steps, never the value', async () => {
    const run = await deploy(false, inGitHub);
    expect(run.summary).toBe(
      markdown([
        '### ❌ Password written in sealup.yml: nothing was changed on production',
        '',
        '> [!CAUTION]',
        '> `targets.production.password` (sealup.yml line 5) holds a password instead of a variable. sealup takes passwords only from variables, so they stay out of git.',
        '>',
        '> **Fix:**',
        `> 1. Add the secret \`PRODUCTION_PASSWORD\` and pass it under \`env:\` of the sealup step: \`PRODUCTION_PASSWORD: $\{{ secrets.PRODUCTION_PASSWORD }}\``,
        `> 2. On line 5 write \`password: ${variable}\``,
        "> 3. **Change that password with your host:** it is in this repository's history.",
        '',
        summaryFooter('secret-in-config'),
      ]),
    );
  });
});
