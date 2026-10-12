// The lock (spec #41 decision 24, decision 0031, ticket 12) as main() prints it: one run at a
// time per target folder. A held lock stops a deploy before any change (exit 6, `lock-held`); a
// note not rewritten for 10 minutes is taken over with a warning; a dry run reports the lock and
// never takes one; `pull` takes none. The lock is the folder `<manifest name>.lock` beside the
// manifest, holding `note.json`.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connect, ServerPath } from '../../src/contracts/index.ts';
import {
  canaries,
  createFtpServer,
  createMemoryServer,
  type FtpServer,
  goldenText,
} from '../../src/testkit/index.ts';
import {
  createProject,
  inGitHub,
  memorySite,
  productionConfig,
  pullProject,
  ref,
  runMain,
} from '../deploy-kit.ts';
import { dialing, sftpTarget, testServer, testSession } from '../sftp-kit.ts';

type MemoryServer = ReturnType<typeof createMemoryServer>;

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

const env = { PROD_PASSWORD: 'pw-for-tests' };
const minute = 60_000;

/** A server date (whole seconds since 1970) that long ago (ms). */
const secondsAgo = (ms: number): number => Math.floor((Date.now() - ms) / 1000);

/** A note as another sealup writes it: `refreshed` that long ago (ms). */
function note(refreshedAgo: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sealupLock: 1,
    run: '7f3a9c21d04e5b68',
    started: '2026-10-09T08:15:42.000Z',
    refreshed: new Date(Date.now() - refreshedAgo).toISOString(),
    machine: 'build-box',
    ...extra,
  });
}

/** A site deployed once to a memory server; `lock` is its lock folder (the manifest's + .lock). */
async function deployedSite() {
  const project = createProject(productionConfig(), { 'public_html/index.html': '<h1>home</h1>' });
  const server = createMemoryServer({ loginFolder: '/home/deploy' });
  const first = await runMain(['deploy', 'production'], { cwd: project.root, env, server });
  expect(first.exitCode).toBe(0);
  const manifest = [...server.files().keys()].find((path) =>
    path.startsWith('/home/deploy/.sealup/'),
  );
  if (manifest === undefined) throw new Error('no manifest after the first deploy');
  return { project, root: project.root, server, lock: `${manifest}.lock` };
}

/** Whatever the server holds under the manifest folder that is a lock. */
const locks = (server: ReturnType<typeof createMemoryServer>): string[] =>
  [...server.files().keys(), ...server.folders()].filter((path) => path.includes('.lock'));

describe('the lock of a deploy', () => {
  it('is held while it runs, with its note, and removed when it is done', async () => {
    const project = createProject(productionConfig(), { 'public_html/index.html': 'x' });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    let seen: string[] = [];
    let note: unknown;
    const connect: Connect = async () => {
      const session = await server.connect();
      return {
        ...session,
        put: async (source, to, options) => {
          // The first upload into the site: the lock is there, its note written.
          if (to.startsWith('/home/site/') && seen.length === 0) {
            seen = locks(server);
            const file = seen.find((path) => path.endsWith('/note.json'));
            note =
              file === undefined ? undefined : JSON.parse(text(server.files().get(file)?.bytes));
          }
          return session.put(source, to, options);
        },
      };
    };

    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: {
        ...env,
        ...inGitHub,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'acme/site',
        GITHUB_RUN_ID: '42',
      },
      connect,
      machine: 'build-box',
    });

    expect(run.exitCode).toBe(0);
    expect(seen.map((path) => path.replace(/[^/]*\.json\.lock/, '<lock>'))).toEqual([
      '/home/deploy/.sealup/<lock>/note.json',
      '/home/deploy/.sealup/<lock>',
    ]);
    expect(note).toMatchObject({
      sealupLock: 1,
      run: expect.stringMatching(/^[0-9a-f]{16}$/),
      machine: 'build-box',
      ciRun: 'https://github.com/acme/site/actions/runs/42',
    });
    expect(locks(server)).toEqual([]);
  });

  it('is removed when the run fails part-way', async () => {
    const project = createProject(productionConfig(), {
      'public_html/a.html': 'a',
      'public_html/b.html': 'b',
    });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    // The lock's note is the first put, the first upload the second.
    server.faults.failWrite(2, 'quota');

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.exitCode).toBe(1);
    expect(locks(server)).toEqual([]);
  });

  it('is removed when the run is interrupted (Ctrl-C)', async () => {
    const project = createProject(productionConfig(), {
      'public_html/a.html': 'a',
      'public_html/b.html': 'b',
    });
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const ctrlC = new AbortController();
    const connect: Connect = async () => {
      const session = await server.connect();
      return {
        ...session,
        put: async (source, to, options) => {
          if (to.startsWith('/home/site/')) ctrlC.abort();
          return session.put(source, to, options);
        },
      };
    };

    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env,
      connect,
      signal: ctrlC.signal,
    });

    expect(run.exitCode).toBe(130);
    expect(locks(server)).toEqual([]);
  });
});

describe('a deploy that finds the lock held', () => {
  it('stops before any change, says who holds it and since when, and exits 6', async () => {
    const { project, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, note(minute));
    const before = server.files();

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.stderr).toContain(
      goldenText(
        [
          '  {rb}✗{/} {b}Another run is deploying to production: sealup stopped.{/}',
          '    Run 7f3a9c21d04e5b68 on build-box has held it since 2026-10-09 08:15 UTC.',
          '    Let it finish, then deploy again. A lock whose run died is taken over',
          '    once its note is 10 minutes old.',
          '',
          '    Nothing was changed on production.',
          '    {d}More: sealup.dev/e/lock-held{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(6);
    expect(server.files()).toEqual(before);
  });
});

describe('the note of a long transfer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is rewritten every 30 s, even when the manifest has nothing new to record', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const site = await memorySite(
      { 'public_html/a.html': 'a', 'public_html/b.html': 'b' },
      { config: `parallel: 1\n${productionConfig()}` },
    );
    const notes: number[] = [];
    let holding = true;
    let sending = false;
    const slow: Connect = async () => {
      const session = await site.server.connect();
      return {
        ...session,
        put: async (source, to, options) => {
          // b.html takes a long time to send.
          if (to.includes('/.b.html.sealup-')) sending = true;
          while (to.includes('/.b.html.sealup-') && holding) await sleep(1);
          await session.put(source, to, options);
          // Each note as it lands on the server.
          if (to.endsWith('/note.json') && 'bytes' in source) {
            notes.push(Date.parse(JSON.parse(text(source.bytes)).refreshed));
          }
        },
      };
    };

    const running = site.run(slow);
    await until(() => sending);
    expect(notes).toHaveLength(1);
    // 30 s on: a.html arrived since the start (a checkpoint), and the note is rewritten.
    site.passTime(30_000);
    vi.advanceTimersByTime(30_000);
    await until(() => notes.length === 2);
    // 30 s more: nothing new arrived, so no checkpoint; the note is rewritten all the same.
    site.passTime(30_000);
    vi.advanceTimersByTime(30_000);
    await until(() => notes.length === 3);
    holding = false;
    const { outcome } = await running;

    expect(outcome).toMatchObject({ status: 'ok', uploaded: 2 });
    const [first = 0, second = 0, third = 0] = notes;
    expect(second - first).toBeGreaterThanOrEqual(30_000);
    expect(third - second).toBeGreaterThanOrEqual(30_000);
    expect(locks(site.server)).toEqual([]);
  });
});

/** Waits for `done`, polling: fake timers leave real ones alone. */
async function until(done: () => boolean): Promise<void> {
  const started = performance.now();
  while (!done()) {
    if (performance.now() - started > 5_000) throw new Error('waited 5 s');
    await sleep(1);
  }
}

describe('two runs started together', () => {
  it('over SFTP: exactly one deploys, the other stops with exit 6 and changes nothing', async () => {
    const sftp = await testServer({ password: env.PROD_PASSWORD });
    const config = productionConfig().replace(/hostKey: .*/, `hostKey: ${sftp.hostKeyLine}`);
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`public_html/page${i}.html`, `page ${i}`]),
    );
    const one = createProject(config, files);
    const other = createProject(config, { 'public_html/other.html': 'other' });
    // The runs overlap whatever their logins take: a run's first upload into the site waits
    // until the other run has ended (it tried the lock and stopped) or reached its own first
    // upload (it holds the lock too: both deploy, the red case). Without it, a run that logs in
    // slowly could find the lock already released and deploy after the first, rightly.
    const ended = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const uploading = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const overlapping = (me: number): Connect => {
      const them = 1 - me;
      return async (target, options) => {
        const session = await dialing(sftp)(target, options);
        return {
          ...session,
          put: async (source, to, putOptions) => {
            if (to.startsWith('/home/site/')) {
              uploading[me]?.resolve();
              await Promise.race([ended[them]?.promise, uploading[them]?.promise]);
            }
            return session.put(source, to, putOptions);
          },
        };
      };
    };

    const runs = await Promise.all(
      [one, other].map(async (project, me) => {
        try {
          return await runMain(['deploy', 'production'], {
            cwd: project.root,
            env,
            connect: overlapping(me),
          });
        } finally {
          ended[me]?.resolve();
        }
      }),
    );

    const codes = runs.map((run) => run.exitCode);
    expect([...codes].sort()).toEqual([0, 6]);
    const blocked = runs[codes.indexOf(6)];
    expect(blocked?.stderr).toContain('Another run is deploying to production: sealup stopped.');
    const deployed = [...sftp.files().keys()].filter((path) => path.startsWith('/home/site/'));
    // The winner's files only: the other changed nothing.
    expect(deployed).toHaveLength(codes[0] === 0 ? 20 : 1);
    expect(
      [...sftp.files().keys(), ...sftp.folders()].filter((path) => path.includes('.lock')),
    ).toEqual([]);
  });
});

describe('over SFTP, a lock that changes between a failed mkdir and the next request', () => {
  /** A site deployed once over the in-process SFTP server; `lock` is its lock folder. */
  async function sftpSite() {
    const sftp = await testServer({ password: env.PROD_PASSWORD });
    const config = productionConfig().replace(/hostKey: .*/, `hostKey: ${sftp.hostKeyLine}`);
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    const deploy = (root: string, connect: Connect = dialing(sftp)) =>
      runMain(['deploy', 'production'], { cwd: root, env, connect });
    expect((await deploy(project.root)).exitCode).toBe(0);
    const manifest = [...sftp.files().keys()].find((path) => path.startsWith('/home/deploy/'));
    if (manifest === undefined) throw new Error('no manifest after the first deploy');
    /** Another client of the same server: the run that holds the lock, or a third one. */
    const other = await testSession(sftpTarget(sftp));
    const lockFiles = () =>
      [...sftp.files().keys(), ...sftp.folders()].filter((path) => path.includes('.lock'));
    return { sftp, config, project, deploy, other, lockFiles, lock: `${manifest}.lock` };
  }

  it('a lock its holder releases just after this run found it is taken: exit 0', async () => {
    const { sftp, project, deploy, other, lockFiles, lock } = await sftpSite();
    sftp.seedFile(`${lock}/note.json`, note(minute));
    // Its holder releases it between this run's failed mkdir and its next request.
    sftp.faults.afterFailedMkdir(lock, async () => {
      await other.remove(`${lock}/note.json` as ServerPath);
      await other.rmdir(lock as ServerPath);
    });
    writeFileSync(join(project.root, 'public_html', 'index.html'), 'v2');

    const run = await deploy(project.root);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(text(sftp.files().get('/home/site/index.html')?.bytes)).toBe('v2');
    expect(lockFiles()).toEqual([]);
  });

  it('a run that lost the claim on a dead lock never claims it again, even once that claim is gone: exit 6', async () => {
    const { sftp, config, deploy, other, lock } = await sftpSite();
    sftp.seedFile(`${lock}/note.json`, note(25 * minute), { mtime: secondsAgo(25 * minute) });
    const claim = `${lock}/took-1` as ServerPath;
    // Both runs judge the dead lock (next claim took-1) before either claims it.
    let judged = 0;
    const bothJudged = Promise.withResolvers<void>();
    const judging: Connect = async (target, options) => {
      const session = await dialing(sftp)(target, options);
      let reads = 0;
      return {
        ...session,
        read: async (path, max) => {
          const read = await session.read(path, max);
          if (path === `${lock}/note.json` && reads++ === 0 && ++judged === 2) {
            bothJudged.resolve();
          }
          return read;
        },
        mkdir: async (path) => {
          if (path === claim) await bothJudged.promise;
          return session.mkdir(path);
        },
      };
    };
    // The loser's failed claim is answered once the winner has deployed and released the lock
    // (note, took-1, then the folder), and a third run has made it again and holds it.
    const winnerEnded = Promise.withResolvers<void>();
    const third = note(0, { run: 'c0ffee0123456789', machine: 'third-box' });
    sftp.faults.afterFailedMkdir(claim, async () => {
      await winnerEnded.promise;
      await other.mkdir(lock as ServerPath);
      await other.put(
        { bytes: new TextEncoder().encode(third) },
        `${lock}/note.json` as ServerPath,
      );
    });
    const projects = ['one', 'two'].map((name) =>
      createProject(config, { [`public_html/${name}.html`]: name }),
    );

    const runs = await Promise.all(
      projects.map(async (project) => {
        try {
          return await deploy(project.root, judging);
        } finally {
          // The loser cannot end before the winner: its claim's answer waits for it.
          winnerEnded.resolve();
        }
      }),
    );

    const codes = runs.map((run) => run.exitCode);
    expect([...codes].sort(), runs.map((run) => run.stderr).join('\n')).toEqual([0, 6]);
    expect(runs[codes.indexOf(6)]?.stderr).toContain('Run c0ffee0123456789 on third-box');
    // The third run's lock is untouched: its note, and no claim of the loser's inside it.
    expect(text(sftp.files().get(`${lock}/note.json`)?.bytes)).toBe(third);
    expect(sftp.folders().filter((path) => path.startsWith(`${lock}/`))).toEqual([]);
    const loser = codes.indexOf(6) === 0 ? 'one' : 'two';
    expect(sftp.files().has(`/home/site/${loser}.html`)).toBe(false);
  });
});

describe('two runs that find the same dead lock', () => {
  it('take it over once between them: exactly one deploys, the other stops with exit 6', async () => {
    const { project, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, note(25 * minute), { mtime: secondsAgo(25 * minute) });
    const other = createProject(productionConfig(), { 'public_html/other.html': 'other' });
    // Each run judges the dead lock before the other changes anything; the second one's first
    // change in the lock folder waits until the first holds it (its note written), and the first
    // one releases it only once the second one has made that change.
    let judged = 0;
    let bothJudged: () => void = () => {};
    const judging = new Promise<void>((resolve) => (bothJudged = resolve));
    let firstHeld = false;
    let firstHolds: () => void = () => {};
    const holding = new Promise<void>((resolve) => (firstHolds = resolve));
    let secondTried: () => void = () => {};
    const tried = new Promise<void>((resolve) => (secondTried = resolve));
    const inLock = (path: string) => path.startsWith(`${lock}/`) || path === lock;
    const runAs = (first: boolean): Connect => {
      let changes = 0;
      let reads = 0;
      return async () => {
        const session = await server.connect();
        /** A change at `path`, held at its gate (the run's first mkdir comes before it judges). */
        const gated = async <T>(path: ServerPath, work: () => Promise<T>): Promise<T> => {
          if (!inLock(path) || reads === 0 || changes++ !== 0) return work();
          await judging;
          if (first) return work();
          await holding;
          try {
            return await work();
          } finally {
            secondTried();
          }
        };
        return {
          ...session,
          read: async (path, max) => {
            const result = await session.read(path, max);
            if (path === `${lock}/note.json` && reads++ === 0 && ++judged === 2) bothJudged();
            return result;
          },
          remove: async (path) => {
            // The first run's release: not before the second one tried.
            if (first && path === `${lock}/note.json` && firstHeld) await tried;
            return gated(path, () => session.remove(path));
          },
          rmdir: (path) => gated(path, () => session.rmdir(path)),
          mkdir: (path) => gated(path, () => session.mkdir(path)),
          put: async (source, to, options) => {
            await gated(to, () => session.put(source, to, options));
            // The first run's own note: it holds the lock now.
            if (first && to === `${lock}/note.json`) {
              firstHeld = true;
              firstHolds();
            }
          },
        };
      };
    };

    const runs = await Promise.all([
      runMain(['deploy', 'production'], { cwd: project.root, env, connect: runAs(true) }),
      runMain(['deploy', 'production'], { cwd: other.root, env, connect: runAs(false) }),
    ]);

    expect(runs.map((run) => run.exitCode)).toEqual([0, 6]);
    expect(runs[1]?.stderr).toContain('More: sealup.dev/e/lock-held');
    expect(server.files().has('/home/site/other.html')).toBe(false);
    expect(locks(server)).toEqual([]);
  });
});

describe('a held lock in every output form', () => {
  it('--json: status blocked, exit 6, the error with its slug', async () => {
    const { project, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, note(minute, { ciRun: 'https://ci.example.com/run/7' }));

    const run = await runMain(['deploy', 'production', '--json'], {
      cwd: project.root,
      env,
      server,
    });

    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'blocked',
      exitCode: 6,
      uploaded: 0,
      error: {
        code: 'lock-held',
        message: 'Another run is deploying to production: sealup stopped.',
        fix: [
          'Run 7f3a9c21d04e5b68 on build-box has held it since 2026-10-09 08:15 UTC.',
          'CI run: https://ci.example.com/run/7',
          'Let it finish, then deploy again. A lock whose run died is taken over',
          'once its note is 10 minutes old.',
        ].join('\n'),
        state: 'Nothing was changed on production.',
      },
    });
    expect(run.exitCode).toBe(6);
  });

  it('GitHub: an error annotation and the job summary', async () => {
    const { project, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, note(minute));

    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      server,
    });

    expect(run.stderr).toContain(
      '::error title=Another run is deploying to production::Run 7f3a9c21d04e5b68 on build-box has held it since 2026-10-09 08:15 UTC. Let it finish, then deploy again. A lock whose run died is taken over once its note is 10 minutes old. Nothing was changed on production.\n',
    );
    expect(run.summary).toContain(
      '### ❌ Another run is deploying to production: sealup stopped: nothing was changed on production',
    );
    expect(run.summary).toContain('[More: sealup.dev/e/lock-held](https://sealup.dev/e/lock-held)');
    expect(run.exitCode).toBe(6);
  });

  it('a note sealup cannot read: names the lock folder to remove by hand', async () => {
    const { project, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, '{"sealupLock": 2}');

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.stderr).toContain(
      goldenText(
        [
          '  {rb}✗{/} {b}Another run holds production: sealup stopped.{/}',
          '    Its lock has no note sealup can read, so sealup cannot tell whose it is.',
          '    If no run is deploying to production, remove this folder on the server:',
          `      ${lock}`,
          '',
          '    Nothing was changed on production.',
          '    {d}More: sealup.dev/e/lock-held{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(6);
  });
});

describe('a lock whose run died', () => {
  it('is taken over once its note is 10 minutes old, with a warning naming the old run', async () => {
    const { project, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, note(25 * minute + 5_000), {
      mtime: secondsAgo(25 * minute + 5_000),
    });
    writeFileSync(join(project.root, 'public_html', 'index.html'), 'v2');

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.stderr).toContain(
      goldenText(
        [
          '  {y}!{/} Took over the lock of a run that stopped answering 25 min ago:',
          '    run 7f3a9c21d04e5b68 on build-box, started 2026-10-09 08:15 UTC.',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(locks(server)).toEqual([]);
    expect(text(server.files().get('/home/site/index.html')?.bytes)).toBe('v2');
  });

  it('GitHub: the takeover is a warning annotation and a WARNING box in the summary', async () => {
    const { project, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, note(12 * minute), { mtime: secondsAgo(12 * minute) });

    const run = await runMain(['deploy', 'production'], {
      cwd: project.root,
      env: { ...env, ...inGitHub },
      server,
    });

    expect(run.stderr).toContain(
      '::warning title=Lock taken over::Took over the lock of a run that stopped answering 12 min ago: run 7f3a9c21d04e5b68 on build-box, started 2026-10-09 08:15 UTC.\n',
    );
    expect(run.summary).toContain(
      [
        '> [!WARNING]',
        '> Took over the lock of a run that stopped answering 12 min ago: run 7f3a9c21d04e5b68 on build-box, started 2026-10-09 08:15 UTC.',
      ].join('\n'),
    );
    expect(run.exitCode).toBe(0);
  });

  it.each([
    [
      'an empty note',
      (server: MemoryServer, lock: string, mtime: number) =>
        server.seedFile(`${lock}/note.json`, '', { mtime }),
    ],
    [
      'no note at all',
      (server: MemoryServer, lock: string, mtime: number) => server.seedFolder(lock, { mtime }),
    ],
  ])(
    'a lock with %s is taken over once the server has seen nothing of it for 10 minutes',
    async (_, seed) => {
      const { project, server, lock } = await deployedSite();
      seed(server, lock, secondsAgo(11 * minute));

      const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

      expect(run.stderr).toContain(
        goldenText(
          ['  {y}!{/} Took over a lock with no note: its run stopped before writing one.'],
          {
            color: false,
          },
        ),
      );
      expect(run.exitCode).toBe(0);
      expect(locks(server)).toEqual([]);
    },
  );

  it.each([
    [
      'an empty note',
      (server: MemoryServer, lock: string, mtime: number) =>
        server.seedFile(`${lock}/note.json`, '', { mtime }),
    ],
    [
      'no note at all',
      (server: MemoryServer, lock: string, mtime: number) => server.seedFolder(lock, { mtime }),
    ],
  ])('a lock with %s from a few seconds ago is a live run’s: held, exit 6', async (_, seed) => {
    const { project, server, lock } = await deployedSite();
    seed(server, lock, secondsAgo(5_000));
    const before = server.files();

    const run = await runMain(['deploy', 'production'], { cwd: project.root, env, server });

    expect(run.stderr).toContain('More: sealup.dev/e/lock-held');
    expect(run.exitCode).toBe(6);
    expect(server.files()).toEqual(before);
  });
});

describe('the age of a lock is the server’s, not this machine’s (decision 0040)', () => {
  it('a note the server saw a minute ago is held, with this machine’s clock an hour ahead', async () => {
    const site = await memorySite({ 'public_html/index.html': 'x' });
    expect((await site.run()).outcome.status).toBe('ok');
    const lock = [...site.server.files().keys()].find((path) => path.startsWith('/home/deploy/'));
    site.server.seedFile(`${lock}.lock/note.json`, note(minute), {
      mtime: secondsAgo(minute),
    });
    site.skewClock(60 * minute);
    site.write('public_html/index.html', 'v2');

    const { outcome } = await site.run();

    expect(outcome).toMatchObject({ exitCode: 6, problem: { code: 'lock-held' } });
  });

  it('a note the server last saw 25 minutes ago is taken over, with this machine’s clock an hour behind', async () => {
    const site = await memorySite({ 'public_html/index.html': 'x' });
    expect((await site.run()).outcome.status).toBe('ok');
    const lock = [...site.server.files().keys()].find((path) => path.startsWith('/home/deploy/'));
    site.server.seedFile(`${lock}.lock/note.json`, note(25 * minute), {
      mtime: secondsAgo(25 * minute),
    });
    site.skewClock(-60 * minute);
    site.write('public_html/index.html', 'v2');

    const { outcome, events } = await site.run();

    expect(outcome.status).toBe('ok');
    const taken = events.find((event) => event.type === 'lock');
    expect(taken).toMatchObject({ type: 'lock', stale: true, holder: { run: '7f3a9c21d04e5b68' } });
    expect(taken?.type === 'lock' && taken.silentMs).toBeGreaterThanOrEqual(25 * minute);
    expect(taken?.type === 'lock' && taken.silentMs).toBeLessThan(26 * minute);
  });
});

describe('a lock with no note over FTP (its note is written in more than one step)', () => {
  const servers: FtpServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
  });

  /** A site deployed once over FTP; `lock` is its lock folder. */
  async function ftpSite() {
    const server = await createFtpServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    servers.push(server);
    const config = [
      'upload: public_html',
      'targets:',
      '  production:',
      '    server: ftp://deploy@ftp.example.com/www',
      `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
      '',
    ].join('\n');
    const project = createProject(config, { 'public_html/index.html': '<h1>home</h1>' });
    const deploy = () =>
      runMain(['deploy', 'production'], { cwd: project.root, connect: dialing(server) });
    expect((await deploy()).exitCode).toBe(0);
    const manifest = [...server.files().keys()].find((path) => path.includes('/.sealup/'));
    if (manifest === undefined) throw new Error('no manifest after the first deploy');
    return { server, deploy, lock: `${manifest}.lock` };
  }

  it('an empty note seconds old is a live run’s: held, exit 6, nothing changed', async () => {
    const { server, deploy, lock } = await ftpSite();
    server.seedFile(`${lock}/note.json`, '');
    const before = server.files();

    const run = await deploy();

    expect(run.stderr).toContain('More: sealup.dev/e/lock-held');
    expect(run.exitCode).toBe(6);
    expect(server.files()).toEqual(before);
  });

  it('an empty note 11 minutes old is taken over', async () => {
    const { server, deploy, lock } = await ftpSite();
    server.seedFile(`${lock}/note.json`, '', { mtime: secondsAgo(11 * minute) });

    const run = await deploy();

    expect(run.stderr).toContain('Took over a lock with no note');
    expect(run.exitCode).toBe(0);
    expect(
      [...server.files().keys(), ...server.folders()].filter((path) => path.includes('.lock')),
    ).toEqual([]);
  });
});

describe('a dry run', () => {
  it('reports a held lock, never takes one, and still shows its plan (exit 0)', async () => {
    const { root, server, lock } = await deployedSite();
    server.seedFile(`${lock}/note.json`, note(minute));
    writeFileSync(join(root, 'public_html', 'index.html'), 'v2');
    const before = server.files();

    const run = await runMain(['deploy', 'production', '--dry-run'], { cwd: root, env, server });

    expect(run.stderr).toContain(
      goldenText(
        [
          '  {y}!{/} Another run is deploying to production: a deploy now would stop.',
          '    Run 7f3a9c21d04e5b68 on build-box, started 2026-10-09 08:15 UTC.',
          '',
          '  Would upload 1 file                                                2 B',
          '    ~ index.html                                                     2 B',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(server.files()).toEqual(before);
  });

  it('takes no lock when none is held', async () => {
    const { root, server } = await deployedSite();
    const files = server.files();
    const folders = server.folders();

    const run = await runMain(['deploy', 'production', '--dry-run'], { cwd: root, env, server });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain(' ! ');
    expect(server.files()).toEqual(files);
    expect(server.folders()).toEqual(folders);
  });
});

describe('pull', () => {
  it('takes no lock: it pulls while another run holds the target', async () => {
    const server = createMemoryServer({ loginFolder: '/home/deploy' });
    const project = pullProject(server);
    server.seedFile('/home/deploy/.sealup/home-site-a069873e.json.lock/note.json', note(minute));
    const files = server.files();

    const run = await runMain(['pull', 'production'], { cwd: project.root, server, tty: true });

    expect(run.exitCode).toBe(0);
    expect(server.files()).toEqual(files);
  });
});
