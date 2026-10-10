// deploy() behind the Session port (spec #1, seam 1): the Outcome of a run that stopped part-way
// tells what really happened, so `--json` can say it: what arrived, and each file that failed
// with its error code (spec "--json object": `failed` after a partial run).

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import { createProject, eventLog, productionConfig } from '../deploy-kit.ts';

describe('a run that stops part-way', () => {
  it('counts what arrived and lists the file that failed, with its code', async () => {
    const project = createProject(productionConfig(), {
      'public_html/a.html': 'aaaa',
      'public_html/b.html': 'bbbb',
      'public_html/c.html': 'cccc',
    });
    const server = createMemoryServer();
    // The second upload: the lock's note (decision 0031) is the first put.
    server.faults.failWrite(3, 'quota');
    const loaded = await loadConfig(project.config, { PROD_PASSWORD: 'pw-for-tests' });
    if (!loaded.ok) throw new Error('fixture config');

    const outcome = await deploy(
      { config: loaded.config, target: undefined },
      {
        connect: () => server.connect(),
        emit: eventLog().emit,
        signal: undefined,
        clock: steppedClock(0),
      },
    );

    expect(outcome).toMatchObject({
      status: 'partial',
      exitCode: 1,
      uploaded: 2,
      deleted: 0,
      bytes: 8,
      failed: [{ path: 'b.html', code: 'quota' }],
      problem: { code: 'transport', changed: true },
    });
  });
});
