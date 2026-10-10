// report, leaf tables: the numbers as the CLI page prints them (decision 0024; page code
// `byteUnit`, notes cli-output.md "Numbers"), and the docs slugs (ruling 9).

import { describe, expect, it } from 'vitest';
import {
  type ConfigIssue,
  type DeployEvent,
  type Outcome,
  type PartialRun,
  type Problem,
  type RemotePath,
  type ServerPath,
  type Sha256,
  type Target,
  TransportError,
} from '../../src/contracts/index.ts';
import {
  createTerminalReporter,
  docsSlugs,
  formatBytes,
  formatCount,
  formatSeconds,
  printNotWritten,
} from '../../src/report/index.ts';
import { createSecret } from '../../src/secret/index.ts';

const stopped: Outcome = {
  status: 'failed',
  exitCode: 2,
  uploaded: 0,
  written: 0,
  deleted: 0,
  unchanged: 0,
  bytes: 0,
  durationMs: 0,
  timings: { connect: 0, scan: 0, compare: 0, transfer: 0 },
  problem: { code: 'usage', reason: 'unknown-flag', name: '--x' },
};

describe('numbers', () => {
  it.each([
    [0, '0'],
    [14, '14'],
    [5862, '5,862'],
    [1_234_567, '1,234,567'],
  ])('counts %d as %s', (n, text) => {
    expect(formatCount(n)).toBe(text);
  });

  // Values from the page's scenarios (S07, S08, S10) and the unit rules: 1024-based, KB without
  // a decimal, MB and GB with one, none from 100 of a unit on.
  it.each([
    [0, '0 B'],
    [1023, '1,023 B'],
    [3 * 1024, '3 KB'],
    [421_888, '412 KB'],
    [2_223_104, '2.1 MB'],
    [42_991_616, '41.0 MB'],
    [327_155_712, '312 MB'],
    [5 * 1024 ** 3, '5.0 GB'],
  ])('sizes %d bytes as %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });

  it.each([
    [15_600, '15.6 s'],
    [3_000, '3.0 s'],
    [0, '0.0 s'],
    [140_250, '140.3 s'],
  ])('times %d ms as %s', (ms, text) => {
    expect(formatSeconds(ms)).toBe(text);
  });
});

describe('the progress line (terminal only; page code progressText, BAR_CELLS = 30)', () => {
  /** What a terminal reporter writes for one progress event (colour off: the words). */
  function drawn(
    progress: Omit<Extract<DeployEvent, { type: 'progress' }>, 'type'>,
    terminal = true,
  ): string {
    let text = '';
    const reporter = createTerminalReporter({
      write: (chunk) => (text += chunk),
      color: false,
      terminal,
    });
    reporter.on({ type: 'progress', ...progress });
    return text;
  }
  const erase = '\r\x1b[2K';

  // The page's own strings (notes cli-output.md "Progress line"), S07's 5,862 files: exactly 80
  // columns, so the gaps are two spaces.
  it.each([
    [
      2931,
      21_495_808,
      6_800,
      '  ↑ ━━━━━━━━━━━━━━━───────────────   2,931 / 5,862 files  20.5 / 41.0 MB   6.8 s',
    ],
    [
      5862,
      42_991_616,
      13_700,
      '  ↑ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   5,862 / 5,862 files  41.0 / 41.0 MB  13.7 s',
    ],
  ])('draws %d of 5,862 files in place of the last one', (files, bytes, elapsedMs, line) => {
    const progress = { files, totalFiles: 5862, bytes, totalBytes: 42_991_616 };
    const text = drawn({ ...progress, elapsedMs, transferMs: elapsedMs });
    expect(text).toBe(`${erase}${line}`);
    expect(line).toHaveLength(80);
  });

  // S08's 14 files: three-space gaps. Seconds are padded to four characters so the line does not
  // jump while it runs (the page pads them to the scenario's known total, one space less here).
  it('draws a short run with three-space gaps', () => {
    const text = drawn({
      files: 9,
      totalFiles: 14,
      bytes: 1_468_006,
      totalBytes: 2_223_104,
      elapsedMs: 700,
      transferMs: 700,
    });
    expect(text).toBe(
      `${erase}  ↑ ━━━━━━━━━━━━━━━━━━━───────────    9 / 14 files   1.4 / 2.1 MB    0.7 s`,
    );
  });

  it('draws nothing when the output is not a terminal', () => {
    const progress = {
      files: 1,
      totalFiles: 2,
      bytes: 1,
      totalBytes: 2,
      elapsedMs: 100,
      transferMs: 0,
    };
    expect(drawn(progress, false)).toBe('');
  });

  it('redraws at most ten times a second, and always the last state', () => {
    let text = '';
    const reporter = createTerminalReporter({
      write: (chunk) => (text += chunk),
      color: false,
      terminal: true,
    });
    const at = (files: number, elapsedMs: number): void =>
      reporter.on({
        type: 'progress',
        files,
        totalFiles: 4,
        bytes: files,
        totalBytes: 4,
        elapsedMs,
        transferMs: elapsedMs,
      });
    at(1, 0);
    at(2, 50);
    at(3, 120);
    at(4, 130);
    expect(
      text
        .split(erase)
        .filter(Boolean)
        .map((line) => line.split('   ')[1]),
    ).toEqual(['1 / 4 files', '3 / 4 files', '4 / 4 files']);
  });

  it('is erased before the next line, which takes its place', () => {
    let text = '';
    const reporter = createTerminalReporter({
      write: (chunk) => (text += chunk),
      color: false,
      terminal: true,
    });
    reporter.on({
      type: 'progress',
      files: 1,
      totalFiles: 1,
      bytes: 1,
      totalBytes: 1,
      elapsedMs: 0,
      transferMs: 0,
    });
    const drawnLine = text;
    reporter.on({ type: 'done', outcome: stopped });
    expect(text.startsWith(`${drawnLine}${erase}`)).toBe(true);
    expect(text.slice(drawnLine.length + erase.length)).toMatch(/^ {2}✗ /);
  });
});

describe('the 25/50/75 % lines (log forms; spec #24 decision 28)', () => {
  /** What a log reporter writes for these progress events (bytes done, transfer ms). */
  function logged(totalBytes: number, events: readonly (readonly [number, number])[]): string[] {
    let text = '';
    const reporter = createTerminalReporter(
      { write: (chunk) => (text += chunk), color: false, terminal: false },
      { form: 'log' },
    );
    events.forEach(([bytes, transferMs], i) => {
      // The run spent 2 s before the transfer: the lines go by the transfer's own time.
      const elapsedMs = transferMs + 2_000;
      const progress = { files: i + 1, totalFiles: 5862, bytes, totalBytes, elapsedMs, transferMs };
      reporter.on({ type: 'progress', ...progress });
    });
    return text.split('\n').filter(Boolean);
  }
  const s07Bytes = 42_991_616;

  // S07's CI form: a 13.7 s transfer, so each mark's projected time is over 5 s. Sizes end at
  // column 72, seconds padded as on the progress line.
  it('prints a line as each mark is crossed, with the numbers of that moment', () => {
    const lines = logged(s07Bytes, [
      [10_000_000, 3_000],
      [10_800_000, 3_400],
      [21_495_808, 6_900],
      [32_300_000, 10_300],
      [s07Bytes, 13_700],
    ]);
    // Done files padded to the total's width, as on the progress line (the page's 1,466 is as
    // wide as 5,862).
    const gap = ' '.repeat(19);
    expect(lines).toEqual([
      `  ↑ 25 %       2 / 5,862 files${gap}10.3 / 41.0 MB    3.4 s`,
      `  ↑ 50 %       3 / 5,862 files${gap}20.5 / 41.0 MB    6.9 s`,
      `  ↑ 75 %       4 / 5,862 files${gap}30.8 / 41.0 MB   10.3 s`,
    ]);
    for (const line of lines) expect(line).toHaveLength(72);
  });

  it('prints none when the projected transfer time is 5 s or less (a 2 s transfer)', () => {
    const lines = logged(4_000, [
      [1_000, 500],
      [2_000, 1_000],
      [3_000, 1_500],
      [4_000, 2_000],
    ]);
    expect(lines).toEqual([]);
  });

  it('judges each mark on its own: a slow start, then a fast end', () => {
    // 25 % at 2 s projects 8 s; 50 % at 2.4 s projects 4.8 s; 75 % at 3.9 s projects 5.2 s.
    const lines = logged(400, [
      [100, 2_000],
      [200, 2_400],
      [300, 3_900],
    ]);
    expect(lines.map((line) => line.slice(0, 8))).toEqual(['  ↑ 25 %', '  ↑ 75 %']);
  });

  it('prints one line, for the highest mark, when one file crosses several', () => {
    const lines = logged(400, [[300, 10_000]]);
    expect(lines.map((line) => line.slice(0, 8))).toEqual(['  ↑ 75 %']);
  });

  it('prints none on a terminal, which has its progress line', () => {
    let text = '';
    const reporter = createTerminalReporter(
      { write: (chunk) => (text += chunk), color: false, terminal: true },
      { form: 'terminal' },
    );
    reporter.on({
      type: 'progress',
      files: 1,
      totalFiles: 4,
      bytes: 1,
      totalBytes: 4,
      elapsedMs: 9_000,
      transferMs: 9_000,
    });
    expect(text).not.toContain('25 %');
  });
});

describe("GitHub's form: no user value starts a workflow command (spec #24 decision 31)", () => {
  /** The lines a GitHub reporter writes for a plan with these uploads, then the end of the run. */
  function github(paths: readonly string[]): string[] {
    let text = '';
    const reporter = createTerminalReporter(
      { write: (chunk) => (text += chunk), color: false, terminal: false },
      { form: 'github' },
    );
    const ops = paths.map((path) => ({
      op: 'upload' as const,
      path: path as RemotePath,
      reason: 'new' as const,
      size: 1,
      sha256: '0'.repeat(64) as Sha256,
    }));
    reporter.on({
      type: 'plan',
      plan: {
        ops,
        unchanged: 0,
        unchangedBytes: 0,
        bytes: ops.length,
        kept: [],
        skipped: [],
        firstDeploy: false,
      },
    });
    reporter.on({ type: 'done', outcome: stopped });
    return text.split('\n');
  }
  /** sealup's own commands; GitHub reads a command after leading spaces too. */
  const own = /^::(add-mask|group|endgroup|error|warning|notice|stop-commands)\b/;

  it('lists a file named ::error::x in the group as it is: its line starts with +', () => {
    const lines = github(['::error::x']);
    expect(lines).toContain(`    + ::error::x${' '.repeat(53)}1 B`);
    expect(lines.filter((line) => /^\s*::/.test(line) && !own.test(line))).toEqual([]);
  });

  it('pauses commands around a line a user value would start: a long path cut before it', () => {
    const path = `${'a'.repeat(70)}/::error::x`;
    const lines = github([path]);
    const at = lines.findIndex((line) => line.trimStart().startsWith('::error::x'));
    const token = /^::stop-commands::([0-9a-f-]{36})$/.exec(lines[at - 1] ?? '')?.[1];
    expect(token).toBeDefined();
    expect(lines[at]).toBe(`      ::error::x${' '.repeat(53)}1 B`);
    expect(lines[at + 1]).toBe(`::${token}::`);
    // A fresh token each time, so no file name can guess it and resume commands early.
    expect(github([path]).join('\n')).not.toContain(token);
  });
});

describe('docs slugs (ruling 9)', () => {
  it('are kebab-case and unique', () => {
    for (const slug of docsSlugs) expect(slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(new Set(docsSlugs).size).toBe(docsSlugs.length);
  });

  it('include the ones on the CLI page', () => {
    expect(docsSlugs).toEqual(
      expect.arrayContaining([
        'target-not-named',
        'unknown-target',
        'variable-not-set',
        'secret-in-config',
        'host-key-missing',
        'host-key-changed',
        'login-refused',
        'quota-full',
      ]),
    );
  });
});

describe('every error (decision 0024 §5; ticket 08)', () => {
  const secret = createSecret('PROD_PASSWORD', 'pw-for-tests');
  if (!secret.ok) throw new Error('fixture secret');
  const place = { file: '/p/sealup.yml', keyPath: 'server', line: 3 };
  const target: Target = {
    name: 'production',
    server: {
      protocol: 'sftp',
      user: 'deploy',
      host: 'ssh.example.com',
      port: 22,
      folder: '/home/site',
    },
    password: secret.secret,
    hostKey: undefined,
    url: undefined,
    uploads: [],
    writes: [],
    pulls: [],
    exclude: [],
    parallel: 64,
    timeoutMs: 30_000,
    manifestFolder: '/~/.sealup',
    allow: new Set(),
    checkServer: false,
    places: { server: place, password: place, hostKey: place },
  };
  const run: PartialRun = {
    uploads: 3,
    arrived: 1,
    missing: [
      { path: 'b.html' as RemotePath, size: 2048 },
      { path: 'c.html' as RemotePath, size: 10 },
    ],
    refused: 1,
    writes: 0,
    written: 0,
    deletes: 0,
    deleted: 0,
    recorded: true,
  };
  const notRecorded: PartialRun = {
    ...run,
    uploads: 1,
    arrived: 1,
    missing: [],
    refused: 0,
    deletes: 2,
    recorded: false,
  };
  const bug = new Error('a bug');
  const codes = [
    'auth',
    'host-key',
    'unreachable',
    'not-found',
    'permission',
    'quota',
    'connection-lost',
    'timeout',
    'protocol',
  ] as const;
  const reasons = {
    auth: 'login-refused',
    'host-key': 'other-key',
    unreachable: 'refused',
    'not-found': 'answer',
    permission: 'answer',
    quota: 'answer',
    'connection-lost': 'lost',
    timeout: 'no-answer',
    protocol: 'answer',
  } as const;
  const problems: [string, Problem][] = [
    ['usage', { code: 'usage', reason: 'unknown-flag', name: '--x' }],
    ['not available yet', { code: 'not-available-yet', what: '--mirror' }],
    ['host key missing', { code: 'host-key-missing', configFile: '/p/sealup.yml' }],
    ...(['invalid', 'unreadable', 'too-large'] as const).map((reason): [string, Problem] => [
      `manifest unusable (${reason})`,
      { code: 'manifest-unusable', reason },
    ]),
    ...[true, false].map((missing): [string, Problem] => [
      `empty source (missing: ${missing})`,
      {
        code: 'empty-source',
        folder: 'dist',
        missing,
        serverFolder: '/~/www/assets',
        target: 'production',
        place: { file: '/p/sealup.yml', line: 1, keyPath: 'upload' },
      },
    ]),
    ['symlink', { code: 'symlink', on: 'source', path: 'dist/latest', target: 'production' }],
    [
      'a symlink on the server (R16)',
      { code: 'symlink', on: 'server', path: '/home/site/api', target: 'production' },
    ],
    ...[true, false].map((connected): [string, Problem] => [
      `manifest folder inside a mapping's folder (connected: ${connected})`,
      {
        code: 'manifest-inside-target',
        manifestFolder: '/~/www/.sealup',
        targetFolder: '/~',
        serverFolder: '/~/www',
        place: { file: '/p/sealup.yml', line: 2, keyPath: 'upload.public_html' },
        connected,
        target: 'production',
      },
    ]),
    ...codes.flatMap((code): [string, Problem][] => {
      const error = new TransportError(code, reasons[code], {
        operation: 'upload',
        path: '/home/site/b.html' as ServerPath,
        timeoutMs: 30_000,
      });
      return [
        [`${code} before any change`, { code: 'transport', error, changed: false }],
        [`${code} part-way`, { code: 'transport', error, changed: true, run }],
        [`${code}, not recorded`, { code: 'transport', error, changed: true, run: notRecorded }],
      ];
    }),
    ...(['control-character', 'backslash', 'drive-letter', 'other'] as const).map(
      (reason): [string, Problem] => [
        `a local name (${reason})`,
        { code: 'bad-local-name', path: 'public_html/a\tb.html', reason, target: 'production' },
      ],
    ),
    ...(['file', 'folder'] as const).flatMap((found) =>
      (['excluded', 'not-uploaded'] as const).map((held): [string, Problem] => [
        `a ${found} in the way (${held}) before any change`,
        { code: 'in-the-way', path: '/home/site/docs' as ServerPath, found, held, changed: false },
      ]),
    ),
    [
      'a folder in the way, part-way',
      {
        code: 'in-the-way',
        path: '/home/site/docs' as ServerPath,
        found: 'folder',
        held: 'not-uploaded',
        changed: true,
        run,
      },
    ],
    ['the target picker left with Esc', { code: 'cancelled', picker: true }],
    ['a question left with Ctrl-C', { code: 'cancelled', picker: false }],
    ['Ctrl-C before any change', { code: 'interrupted', changed: false }],
    ['Ctrl-C part-way', { code: 'interrupted', changed: true, run }],
    ['an unexpected error before any change', { code: 'unexpected', error: bug, changed: false }],
    ['an unexpected error part-way', { code: 'unexpected', error: bug, changed: true, run }],
    ['an unexpected error, change unknown', { code: 'unexpected', error: bug, changed: undefined }],
  ];

  function printed(problem: Problem, options: { debug?: boolean } = {}): string {
    let text = '';
    const reporter = createTerminalReporter(
      { write: (chunk) => (text += chunk), color: false, terminal: false },
      options,
    );
    reporter.on({
      type: 'start',
      target,
      configFile: '/p/sealup.yml',
      dryRun: false,
      warnings: [],
    });
    reporter.on({ type: 'done', outcome: { ...stopped, problem } });
    return text.slice(text.indexOf('  ✗ '));
  }

  it.each(problems)('%s: ✗, then a blank line, a state line, the docs link', (_, problem) => {
    const lines = printed(problem).split('\n');
    expect(lines.at(-1)).toBe('');
    const [link = '', ...before] = lines.slice(0, -1).reverse();
    const slug = /^ {4}More: sealup\.dev\/e\/([a-z-]+)$/.exec(link)?.[1];
    expect(docsSlugs).toContain(slug);
    // At least one state line between the blank line and the link.
    expect(before.indexOf('')).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it.each(problems)('%s: no stack trace without --debug', (_, problem) => {
    expect(printed(problem)).not.toMatch(/^\s+at /m);
    expect(printed(problem)).not.toContain('a bug');
  });

  it('an unreadable private key: names the config file it was given, never "its variable"', () => {
    const key = createSecret('DEPLOY_KEY', 'not a key at all');
    if (!key.ok) throw new Error('fixture key');
    const words = (withKey: Target) => {
      let text = '';
      const reporter = createTerminalReporter({
        write: (chunk) => (text += chunk),
        color: false,
        terminal: false,
      });
      reporter.on({
        type: 'start',
        target: withKey,
        configFile: '/p/deploy.yml',
        dryRun: false,
        warnings: [],
      });
      const problem: Problem = {
        code: 'private-key-unreadable',
        reason: 'key-unreadable',
        target: 'production',
      };
      reporter.on({ type: 'done', outcome: { ...stopped, problem } });
      return text;
    };

    // The key with no place in the file (a target built in code): the file the run was given.
    const placeless = words({ ...target, privateKey: key.secret });
    expect(placeless).toContain(`    deploy.yml reads $\{DEPLOY_KEY}.\n`);
    expect(placeless).not.toContain('sealup.yml');
    // No key variable known: no "reads" line at all.
    const unknown = words(target);
    expect(unknown).not.toContain('its variable');
    expect(unknown).not.toContain(' reads ');
  });

  it('words a server problem from its facts: transport gives no sentence', () => {
    const noHost = new TransportError('unreachable', 'no-such-host');
    expect(printed({ code: 'transport', error: noHost, changed: false })).toContain(
      '    No host named ssh.example.com was found.\n',
    );
    const slow = new TransportError('timeout', 'no-answer', { timeoutMs: 30_000 });
    expect(printed({ code: 'transport', error: slow, changed: false })).toContain(
      '  ✗ No answer from the server in 30.0 s.\n',
    );
    const failed = new TransportError('protocol', 'answer', {
      operation: 'mkdir',
      path: '/home/site/a' as ServerPath,
      serverSaid: 'Failure',
    });
    expect(printed({ code: 'transport', error: failed, changed: false })).toContain(
      '  ✗ Cannot create the folder /home/site/a: the server failed (the server said: Failure).\n',
    );
    const listing = new TransportError('permission', 'answer', {
      operation: 'list',
      path: '/home/site/up' as ServerPath,
    });
    expect(printed({ code: 'transport', error: listing, changed: false })).toContain(
      'Cannot list the folder /home/site/up: permission denied.\n',
    );
    const changed = new TransportError('protocol', 'changed', {
      operation: 'download',
      path: '/home/site/up/a.jpg' as ServerPath,
    });
    expect(printed({ code: 'transport', error: changed, changed: false })).toContain(
      '/home/site/up/a.jpg changed on the server while it was downloaded.\n',
    );
  });

  it('names a local file whose name no server path can hold, its control characters escaped', () => {
    const text = printed({
      code: 'bad-local-name',
      path: 'public_html/a\tb\u0085.html',
      reason: 'control-character',
      target: 'production',
    });
    expect(text.split('\n')[0]).toBe(
      '  ✗ public_html/a\\x09b\\x85.html cannot be sent as it is named.',
    );
  });

  describe('two config lines about one file (stories 43 and 44)', () => {
    const at = (line: number, keyPath: string) => ({ file: '/p/sealup.yml', line, keyPath });
    const sameServerPath = {
      code: 'same-server-path',
      ...at(3, 'upload.config/connect.prod.php'),
      other: at(2, 'upload.public_html'),
      path: 'www/connect.php',
    } as const;
    const excludedFile = {
      code: 'excluded-file',
      ...at(3, 'upload.config/connect.prod.php'),
      other: at(9, 'targets.production.exclude.0'),
    } as const;
    const config = (...issues: ConfigIssue[]): Problem => ({
      code: 'config',
      issues,
      target: 'production',
    });

    it('names both entries that send one server path', () => {
      expect(printed(config(sameServerPath))).toBe(
        [
          '  ✗ Two entries in sealup.yml send www/connect.php.',
          '    upload.config/connect.prod.php (line 3) sends it,',
          '    and so does upload.public_html (line 2).',
          '    sealup will not guess which one wins: change one of the two lines.',
          '',
          '    sealup did not connect. Nothing was changed on production.',
          '    More: sealup.dev/e/same-server-path',
          '',
        ].join('\n'),
      );
    });

    it('names the upload entry and the exclude pattern that leaves its file out', () => {
      expect(printed(config(excludedFile))).toBe(
        [
          '  ✗ A single file in sealup.yml is both uploaded and excluded.',
          '    upload.config/connect.prod.php (line 3) sends it,',
          '    and targets.production.exclude.0 (line 9) leaves it out.',
          '    sealup will not guess which one wins: change one of the two lines.',
          '',
          '    sealup did not connect. Nothing was changed on production.',
          '    More: sealup.dev/e/excluded-file',
          '',
        ].join('\n'),
      );
    });

    it('lists each among other problems with the other line', () => {
      const text = printed(
        config(
          sameServerPath,
          { ...excludedFile, ...at(4, 'upload.x') },
          { code: 'remote-path', ...at(5, 'upload.y'), detail: 'file' },
        ),
      );
      expect(text).toContain(
        '    upload.y (line 5): write a file path in the target folder: no .., no leading /\n',
      );
      expect(text).toContain(
        '    upload.config/connect.prod.php (line 3): sends www/connect.php, as line 2 does\n',
      );
      expect(text).toContain('    upload.x (line 4): line 9 excludes this file\n');
    });
  });

  it('says nothing was changed after an unexpected error that changed nothing (exit 1)', () => {
    const nothingDone: PartialRun = { ...run, arrived: 0, refused: 0 };
    const text = printed({ code: 'unexpected', error: bug, changed: false, run: nothingDone });
    const state = text.slice(text.indexOf('\n\n'));
    expect(state).toContain('    Nothing was changed on production.');
    expect(state).not.toMatch(/again|finish/);
  });

  it('shows the stack of an unexpected error with --debug, after the docs link', () => {
    const text = printed({ code: 'unexpected', error: bug, changed: false }, { debug: true });
    const link = text.indexOf('More: sealup.dev/e/internal-error');
    expect(link).toBeGreaterThan(0);
    expect(text.slice(link)).toContain('Error: a bug');
    expect(text.slice(link)).toMatch(/^\s+at /m);
  });
});

// R1, decision 0009: the action's warnings (outputs, plan file) go through report's one sink,
// redacted, and as one workflow command whose words cannot start another.
describe('printNotWritten: a file sealup could not write for the runner', () => {
  const written = (error: unknown): string => {
    let text = '';
    const out = { write: (chunk: string) => (text += chunk), color: false, terminal: false };
    printNotWritten(out, 'Outputs not written', error);
    return text;
  };

  it('names the error code, never its message', () => {
    const error = Object.assign(new Error('EACCES: permission denied, open /x'), {
      code: 'EACCES',
    });
    expect(written(error)).toBe(
      '::warning title=Outputs not written::sealup could not write it (EACCES).\n',
    );
    expect(written(new Error('no code'))).toBe(
      '::warning title=Outputs not written::sealup could not write it (an error).\n',
    );
  });

  it('escapes and redacts what it writes', () => {
    const made = createSecret('ACTION_CANARY', 'action-canary-pw-77');
    if (!made.ok) throw new Error(made.problem);
    expect(written({ code: 'E%\n::error::action-canary-pw-77' })).toBe(
      '::warning title=Outputs not written::sealup could not write it (E%25%0A::error::[secret]).\n',
    );
  });
});
