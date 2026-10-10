// The freeze test (decision 0026): the frozen seams, each compared with its golden in
// seams/. A change to one fails here, naming the seam and the rule of decision 0026: update the
// golden on purpose and say so in the pull request. The `--json` objects of a success, a dry
// run, a part-way stop, a failure and a run that reconnected are checked by their scenario
// goldens (S07, S10, S20, S18, S11) against seams/json-*.golden; the rest are here. test/gates/freeze.test.ts proves it bites.
//
//   shape.golden                 contracts and plan's exports, as declarations without comments;
//                                every file of contracts is in it (shapeFiles, freeze-kit.ts)
//   manifest-format-2.golden     the bytes of a fixed manifest, format 2 (decision 0032)
//   manifest-format-1.golden     the bytes of the same manifest in format 1 (decision 0007), no
//                                longer written but still read
//   exit-codes.golden            the exit-code table (decision 0023, item 8)
//   docs-slugs.golden            every docs slug, `sealup.dev/e/<slug>` (ruling 9)
//   first-deploy-events.golden   the events of a first deploy: their types, in order

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../scripts/gates.ts';
import { loadConfig } from '../../../src/config/index.ts';
import {
  ExitCode,
  type Manifest,
  type RemotePath,
  type ServerPath,
  type Sha256,
} from '../../../src/contracts/index.ts';
import { deploy } from '../../../src/deploy/index.ts';
import { decode, encode } from '../../../src/manifest/index.ts';
import { docsSlugs } from '../../../src/report/index.ts';
import { createMemoryServer, steppedClock } from '../../../src/testkit/index.ts';
import { createProject, eventLog, productionConfig } from '../../deploy-kit.ts';
import {
  docsSlugsText,
  exitCodesText,
  expectContractsInShape,
  expectFrozen,
  seamGoldens,
  seamShape,
} from '../../freeze-kit.ts';

/** A manifest with a folder, a nested path and a path with a space and a non-ASCII letter. */
const files: Manifest['files'] = new Map([
  ['index.html' as RemotePath, { size: 13, sha256: `${'a1'.repeat(32)}` as Sha256 }],
  ['assets/js/app.js' as RemotePath, { size: 15, sha256: `${'b2'.repeat(32)}` as Sha256 }],
  ['my pages/café.html' as RemotePath, { size: 0, sha256: `${'c3'.repeat(32)}` as Sha256 }],
]);
/** The same, with one upload in flight under its temp name (decision 0032). */
const manifest: Manifest = {
  format: 2,
  folder: '/home/site' as ServerPath,
  files,
  pending: ['my pages/.about us.html.sealup-0123456789abcdef.tmp' as RemotePath],
};

describe('frozen seams', () => {
  it('contracts and plan keep their shape', async () => {
    expectFrozen('the shape of contracts and plan()', await seamShape(repoRoot), 'shape.golden');
  });

  it('every file of contracts is in the shape snapshot', () => {
    expectContractsInShape(repoRoot);
  });

  it('manifest format 2 keeps its bytes, and its golden still reads back', () => {
    const bytes = new TextDecoder().decode(encode(manifest));
    expectFrozen('manifest format 2', bytes, 'manifest-format-2.golden');
    expect(decode(new TextEncoder().encode(bytes))).toEqual(manifest);
  });

  it('manifest format 1 is still read, as a manifest with no pending names', () => {
    const golden = readFileSync(join(seamGoldens, 'manifest-format-1.golden'));
    expect(decode(golden)).toEqual({ ...manifest, pending: [] });
  });

  it('the exit codes keep their numbers', () => {
    expectFrozen('the exit codes', exitCodesText(ExitCode), 'exit-codes.golden');
  });

  it('the docs slugs stay', () => {
    expectFrozen('the docs slugs', docsSlugsText(docsSlugs), 'docs-slugs.golden');
  });

  it('a first deploy sends its events in order', async () => {
    const env = { PROD_PASSWORD: 'pw-for-tests' };
    const project = createProject(productionConfig(), {
      'public_html/index.html': '<h1>home</h1>',
      'public_html/my pages/about us.html': '<h1>about</h1>',
    });
    const loaded = await loadConfig(project.config, env);
    if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const log = eventLog();
    await deploy(
      { config: loaded.config, target: 'production' },
      {
        connect: () => server.connect(),
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0),
      },
    );
    const types = log.events.map((event) => event.type);
    expectFrozen(
      'the events of a first deploy',
      `${types.join('\n')}\n`,
      'first-deploy-events.golden',
    );
  });
});
