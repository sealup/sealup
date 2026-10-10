// deploy() behind the Session port (spec #1, seam 1): the dry run. It connects, reads the
// manifest and plans, then stops: the server tree and the manifest stay byte-identical (spec
// story 26, decision 0024 §4).

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import type { DeployEvent, Outcome } from '../../src/contracts/index.ts';
import { deploy } from '../../src/deploy/index.ts';
import { createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import { createProject, eventLog, productionConfig } from '../deploy-kit.ts';

const env = { PROD_PASSWORD: 'pw-for-tests' };

const build = {
  'public_html/index.html': '<h1>v1</h1>',
  'public_html/main.8b1e3d07.js': 'v1',
  'public_html/robots.txt': 'User-agent: *',
};

async function site() {
  const project = createProject(productionConfig(), build);
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  const run = async (dryRun: boolean): Promise<{ outcome: Outcome; events: DeployEvent[] }> => {
    const loaded = await loadConfig(project.config, env);
    if (!loaded.ok) throw new Error(`fixture config: ${JSON.stringify(loaded.issues)}`);
    const log = eventLog();
    const outcome = await deploy(
      { config: loaded.config, target: 'production', dryRun },
      {
        connect: () => server.connect(),
        emit: log.emit,
        signal: undefined,
        clock: steppedClock(0, 2_000),
      },
    );
    return { outcome, events: log.events };
  };
  const path = (name: string): string => join(project.root, 'public_html', name);
  return { server, run, path };
}

describe('dry run', () => {
  it('changes nothing on a first deploy: no folder, no file, no manifest', async () => {
    const s = await site();
    const files = s.server.files();
    const folders = s.server.folders();

    const { outcome, events } = await s.run(true);

    expect(s.server.files()).toEqual(files);
    expect(s.server.folders()).toEqual(folders);
    expect(outcome).toMatchObject({ status: 'ok', exitCode: 0, uploaded: 3, deleted: 0 });
    expect(events.map((event) => event.type)).toEqual(['start', 'host-key', 'plan', 'done']);
    expect(events[0]).toMatchObject({ type: 'start', dryRun: true });
  });

  it('leaves the server tree and the manifest byte-identical on a redeploy', async () => {
    const s = await site();
    await s.run(false);
    writeFileSync(s.path('index.html'), '<h1>v2</h1>');
    writeFileSync(s.path('main.4f2a9c1e.js'), 'v2');
    rmSync(s.path('main.8b1e3d07.js'));
    const files = s.server.files();
    const folders = s.server.folders();

    const { outcome, events } = await s.run(true);

    expect(s.server.files()).toEqual(files);
    expect(s.server.folders()).toEqual(folders);
    // On a dry run the counts are what the run would do.
    expect(outcome).toMatchObject({
      status: 'ok',
      exitCode: 0,
      uploaded: 2,
      deleted: 1,
      unchanged: 1,
      bytes: 11 + 2,
      durationMs: 2_000,
    });
    expect(events.map((event) => event.type)).toEqual(['start', 'host-key', 'plan', 'done']);
  });

  it('says unchanged when there is nothing to do', async () => {
    const s = await site();
    await s.run(false);
    const { outcome } = await s.run(true);
    expect(outcome).toMatchObject({ status: 'unchanged', uploaded: 0, deleted: 0, unchanged: 3 });
  });

  it('marks a real run as not dry', async () => {
    const s = await site();
    const { events } = await s.run(false);
    expect(events[0]).toMatchObject({ type: 'start', dryRun: false });
  });
});
