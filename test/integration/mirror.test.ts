// deploy() behind the Session port (decision 0030, seam 1): the full mirror's listing within R21's
// caps (a test lowers them, as the server check's tests do), what it never lists, and its deletes
// after a reconnect (spec #41 decision 20).

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import type { Connect, DeployEvent, Plan, ServerPath } from '../../src/contracts/index.ts';
import { deploy, type ListingLimits, listingLimits } from '../../src/deploy/index.ts';
import { createMemoryServer, steppedClock } from '../../src/testkit/index.ts';
import { createProject, eventLog, productionConfig, siteFiles } from '../deploy-kit.ts';

/** The page's config with every folder below `uploads/` excluded. */
const excluding = productionConfig().replace(
  'targets:',
  'exclude:\n  - public_html/uploads\ntargets:',
);

/** A first deploy with `--mirror` onto a server holding `stray`, under `limits`. */
async function mirrored(
  stray: readonly string[],
  options: {
    limits?: ListingLimits;
    config?: string;
    mirror?: boolean;
    faults?: (server: ReturnType<typeof createMemoryServer>) => void;
  } = {},
) {
  const project = createProject(options.config ?? productionConfig(), {
    'public_html/index.html': '<h1>v1</h1>',
  });
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  for (const path of stray) server.seedFile(`/home/site/${path}`, 'stray');
  options.faults?.(server);
  const before = server.files();
  const loaded = await loadConfig(project.config, { PROD_PASSWORD: 'pw-for-tests' });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const log = eventLog();
  const connect: Connect = () => server.connect();
  const outcome = await deploy(
    {
      config: loaded.config,
      target: 'production',
      mirror: options.mirror ?? true,
      limits: options.limits ?? listingLimits,
    },
    {
      connect,
      emit: log.emit,
      signal: undefined,
      clock: steppedClock(0),
      wait: async () => {},
    },
  );
  return { outcome, server, before, events: log.events };
}

function planOf(events: readonly DeployEvent[]): Plan {
  const event = events.find((e) => e.type === 'plan');
  if (event?.type !== 'plan') throw new Error('no plan event');
  return event.plan;
}

describe('the full mirror within R21 caps', () => {
  it('stops past the entries cap before any change: exit 6, for the mirror', async () => {
    // Listed: the target folder (a, b, c), then a (x): 4 entries.
    const { outcome, server, before } = await mirrored(['a/x', 'b', 'c'], {
      limits: { entries: 3, depth: 64 },
    });

    expect(outcome.problem).toEqual({
      code: 'listing-too-large',
      path: '/home/site/a',
      limit: 'entries',
      max: 3,
      for: 'mirror',
      target: 'production',
    });
    expect(outcome).toMatchObject({ status: 'failed', exitCode: 6, uploaded: 0, deleted: 0 });
    expect(server.files()).toEqual(before);
  });

  it('deletes what it listed at the caps themselves', async () => {
    const { outcome, server } = await mirrored(['a/x', 'b', 'c'], {
      limits: { entries: 4, depth: 2 },
    });

    expect(outcome).toMatchObject({ exitCode: 0, uploaded: 1, deleted: 3 });
    expect(siteFiles(server)).toEqual(['index.html']);
  });

  it('stops past the depth cap: a folder more levels down than the cap', async () => {
    const { outcome, server, before } = await mirrored(['a/b/x'], {
      limits: { entries: 200_000, depth: 1 },
    });

    expect(outcome.problem).toMatchObject({ path: '/home/site/a/b', limit: 'depth', max: 1 });
    expect(outcome.exitCode).toBe(6);
    expect(server.files()).toEqual(before);
  });

  it('never lists below an excluded folder, so its files count for no cap', async () => {
    const uploads = Array.from({ length: 10 }, (_, i) => `uploads/${i}.jpg`);
    const { outcome, server, events } = await mirrored([...uploads, 'old.php'], {
      config: excluding,
      limits: { entries: 3, depth: 64 },
    });

    expect(outcome.exitCode).toBe(0);
    expect(planOf(events).ops).toContainEqual({
      op: 'delete',
      path: 'old.php',
      reason: 'not-in-build',
    });
    expect(siteFiles(server)).toEqual(['index.html', ...uploads].sort());
  });
});

describe('the full mirror after a reconnect (spec #41 decision 20)', () => {
  it('still deletes what is not in the build once the transfer resumes', async () => {
    const { outcome, server } = await mirrored(['old.php', 'old/a.txt'], {
      // The lock's note is the first put: the one upload is put 2.
      faults: (server) => server.faults.failWrite(2, 'connection-lost'),
    });

    expect(outcome).toMatchObject({ exitCode: 0, reconnects: 1 });
    expect(siteFiles(server)).toEqual(['index.html']);
  });
});

describe('scoped exclusions and server links in the full mirror', () => {
  it('keeps an excluded runtime link and its contents while deleting other strays', async () => {
    const config = productionConfig().replace(
      'upload: public_html',
      'upload:\n  public_html:\n    to: .\n    exclude: [storage]',
    );
    const { outcome, server, events } = await mirrored(['old.php'], {
      config,
      faults: (server) => {
        server.seedFile('/outside/sentinel.txt', 'runtime data');
        server.seedLink('/home/site/storage', '/outside');
      },
    });

    expect(outcome).toMatchObject({ exitCode: 0, uploaded: 1, deleted: 1 });
    expect(planOf(events).ops.some(({ path }) => path.startsWith('storage'))).toBe(false);
    expect(siteFiles(server)).toEqual(['index.html']);
    expect(Buffer.from(server.files().get('/outside/sentinel.txt')?.bytes ?? []).toString()).toBe(
      'runtime data',
    );
    const session = await server.connect();
    expect((await session.stat('/home/site/storage' as ServerPath)).kind).toBe('link');
    await session.close();
  });

  it('keeps a separately mirrored root that another mapping excludes', async () => {
    const config = productionConfig()
      .replace(
        'upload: public_html',
        [
          'upload:',
          '  public_html:',
          '    - to: .',
          '      exclude: [storage]',
          '    - to: storage',
          '      exclude: ["*"]',
          '      mirror: true',
        ].join('\n'),
      )
      .replace('  production:', '  production:\n    allow: [empty-source]');
    const { outcome, server } = await mirrored([], {
      config,
      mirror: false,
      faults: (server) => server.seedLink('/home/site/storage', '/outside'),
    });

    expect(outcome).toMatchObject({ exitCode: 0, uploaded: 1, deleted: 0 });
    const session = await server.connect();
    expect((await session.stat('/home/site/storage' as ServerPath)).kind).toBe('link');
    await session.close();
  });

  it('never lists a separately mirrored folder root protected by another mapping', async () => {
    const config = productionConfig()
      .replace(
        'upload: public_html',
        [
          'upload:',
          '  public_html:',
          '    - to: .',
          '      exclude: [storage/]',
          '    - to: storage',
          '      exclude: ["*"]',
          '      mirror: true',
        ].join('\n'),
      )
      .replace('  production:', '  production:\n    allow: [empty-source]');
    const runtime = Array.from({ length: 10 }, (_, index) => `storage/${index}.txt`);
    const { outcome, server } = await mirrored(runtime, {
      config,
      mirror: false,
      limits: { entries: 2, depth: 64 },
    });

    expect(outcome).toMatchObject({ exitCode: 0, uploaded: 1, deleted: 0 });
    expect(siteFiles(server)).toEqual(['index.html', ...runtime].sort());
  });

  it.each(['cache', 'storage/'])(
    'still stops on a runtime link that %s does not exclude',
    async (pattern) => {
      const config = productionConfig().replace(
        'upload: public_html',
        `upload:\n  public_html:\n    to: .\n    exclude: [${pattern}]`,
      );
      const { outcome, server, before } = await mirrored(['old.php'], {
        config,
        faults: (server) => server.seedLink('/home/site/storage', '/outside'),
      });

      expect(outcome.problem).toMatchObject({
        code: 'symlink',
        on: 'server',
        path: '/home/site/storage',
      });
      expect(outcome).toMatchObject({ exitCode: 6, uploaded: 0, deleted: 0 });
      expect(server.files()).toEqual(before);
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'still stops an explicit upload through an excluded link (allow symlinks=%s, all mappings=%s)',
    async (allowed, all) => {
      const config = productionConfig()
        .replace(
          'upload: public_html',
          [
            'upload:',
            '  public_html:',
            '    - to: .',
            '      exclude: [storage]',
            '    - to: storage',
            '      exclude: ["*"]',
            '      mirror: true',
            '  public_html/index.html: storage/index.html',
          ].join('\n'),
        )
        .replace(
          '  production:',
          `  production:\n    allow: [empty-source${allowed ? ', symlinks' : ''}]`,
        );
      const { outcome, server, before } = await mirrored(['old.php'], {
        config,
        mirror: all,
        faults: (server) => {
          server.seedFile('/outside/sentinel.txt', 'runtime data');
          server.seedLink('/home/site/storage', '/outside');
        },
      });

      expect(outcome.problem).toMatchObject({
        code: 'symlink',
        on: 'server',
        path: '/home/site/storage',
      });
      expect(outcome).toMatchObject({ exitCode: 6, uploaded: 0, deleted: 0 });
      expect(server.files()).toEqual(before);
    },
  );
});
