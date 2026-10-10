// R21 for `sealup pull`: the listing stops at its limits (entries in one folder, files in all,
// levels of folders) with a safety net, exit 6, before anything is written here. Through the use
// case with lower limits, so the server stays small; the 64 levels are tested as they are in
// pull.test.ts. The defaults are the spec's (decision 25).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { pull, pullLimits } from '../../src/pull/index.ts';
import { canaries, createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import { pullProject } from '../deploy-kit.ts';

async function pullWith(limits: typeof pullLimits) {
  const server = createMemoryServer();
  const project = pullProject(server);
  const loaded = await loadConfig(project.config, canaries);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const outcome = await pull(
    { config: loaded.config, target: 'production', limits },
    {
      connect: () => server.connect(),
      emit: () => undefined,
      signal: undefined,
      clock: steppedClock(0),
    },
  );
  return { outcome, root: project.root };
}

describe('sealup pull: R21 limits on the listing', () => {
  it('are the spec numbers by default', () => {
    expect(pullLimits).toEqual({ entries: 100_000, files: 1_000_000, depth: 64 });
  });

  it.each([
    ['entries', { ...pullLimits, entries: 2 }, '/home/site/www/resources'],
    ['files', { ...pullLimits, files: 3 }, '/home/site/www/resources/2024/01'],
    ['depth', { ...pullLimits, depth: 1 }, '/home/site/www/resources/2024/01'],
  ] as const)('stop at the %s limit, exit 6, nothing written', async (limit, limits, path) => {
    const { outcome, root } = await pullWith(limits);
    expect(outcome.problem).toEqual({
      code: 'pull-too-large',
      path,
      limit,
      max: limits[limit],
      target: 'production',
    });
    expect(outcome.exitCode).toBe(6);
    expect(existsSync(join(root, 'public_html/resources/2024'))).toBe(false);
  });

  it('pull everything at the limits themselves', async () => {
    const { outcome } = await pullWith({ entries: 3, files: 4, depth: 2 });
    expect(outcome).toMatchObject({ exitCode: 0, downloaded: 2, unchanged: 2 });
  });
});
