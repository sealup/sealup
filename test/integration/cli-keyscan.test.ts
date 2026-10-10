// `sealup keyscan [target]` beyond S04 (spec #24 decision 18, stories 18-24): the key already
// saved, another key saved (replaced only on an explicit yes, else exit 4), a no, Esc, the target
// picker, the words without a terminal, and the scan reading only the target's server: an unset
// password never stops it and no credential is ever sent (R7).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/contracts/index.ts';
import {
  canaries,
  createMemoryServer,
  goldenText,
  screenOf,
  splitMasks,
} from '../../src/testkit/index.ts';
import {
  canaryMasks,
  createProject,
  hostKeyFingerprint,
  hostKeyLine,
  inGitHub,
  ref,
  runMain,
} from '../deploy-kit.ts';
import { dialing, scanDialing, testServer } from '../sftp-kit.ts';

/** The page's staging key (reference.js), as another server's key. */
const otherLine =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIMytt7XOtQoLfxloYx9nFD1pYMdoQ6Dwr6b8D+pHN8R';

const enter = '\r';
const down = '\u001b[B';

/** Two targets; production's key on line 6 when `key` is given. */
function twoTargets(key?: string): string {
  return [
    'upload: public_html',
    'targets:',
    '  production:',
    '    server: sftp://deploy@ssh.example.com/home/site',
    `    password: ${ref('SEALUP_CANARY_PASSWORD')}`,
    ...(key === undefined ? [] : [`    hostKey: ${key}`]),
    '  staging:',
    '    server: sftp://deploy@203.0.113.10/srv/site',
    `    password: ${ref('STAGING_PASSWORD')}`,
    '',
  ].join('\n');
}

const build = { 'public_html/index.html': '<h1>home</h1>' };

/** A memory server that shows the page's key, or `line`. */
const scanOf = (line?: string) =>
  createMemoryServer(line === undefined ? {} : { hostKeyLine: line });

const production = '  production  sftp://deploy@ssh.example.com:22/home/site';

describe('keyscan: the key already saved', () => {
  it('says so with ✓ and asks nothing, exit 0, the file unchanged', async () => {
    const config = twoTargets(hostKeyLine);
    const { root, config: file } = createProject(config, build);
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      tty: true,
      scan: scanOf().scanHostKey,
    });
    expect(run.stderr).toBe(
      goldenText(
        [
          production,
          `  host key    ${hostKeyFingerprint}  {g}saved{/}`,
          '',
          '  {gb}✓ Already saved:{/} sealup.yml holds this key (hostKey, line 6).',
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(config);
  });
});

describe('keyscan: another key saved', () => {
  const block = (received: string) => [production, `  host key    ${received}  {rb}changed{/}`, ''];
  const changed = (received: string) => [
    '    sealup.yml (line 6) expects one key; ssh.example.com sent another:',
    `      expected  ED25519 ${hostKeyFingerprint}`,
    `      received  ED25519 ${received}`,
    '    Either your host moved the site to a new server, or someone between you',
    '    and the server is intercepting the connection.',
  ];

  it('shows both fingerprints, and replaces the line only on an explicit yes', async () => {
    const { root, config: file } = createProject(twoTargets(hostKeyLine), build);
    const server = scanOf(otherLine);
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      tty: true,
      keys: ['yes', enter],
      scan: server.scanHostKey,
    });
    expect(screenOf(run.stderr)).toBe(
      goldenText(
        [
          ...block(server.fingerprint),
          "  {y}!{/} {b}The server's host key changed: sealup.yml holds another one.{/}",
          ...changed(server.fingerprint),
          "    Ask your host for the server's fingerprint, and replace the saved key",
          '    only if it is the received one.',
          '  Replace the saved key? [y/N] y',
          '',
          '  {gb}✓ Replaced.{/} sealup.yml now holds this key (hostKey, line 6).',
          '    From now on sealup checks it before it sends your password. If the',
          '    server ever shows another key, sealup stops and changes nothing.',
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(twoTargets(otherLine));
  });

  it('keeps the saved key on Enter (no by default): exit 4, the file unchanged', async () => {
    const config = twoTargets(hostKeyLine);
    const { root, config: file } = createProject(config, build);
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      tty: true,
      keys: [enter],
      scan: scanOf(otherLine).scanHostKey,
    });
    const screen = screenOf(run.stderr);
    expect(screen.slice(screen.indexOf('  Replace'))).toBe(
      goldenText(
        [
          '  Replace the saved key? [y/N] n',
          '',
          '  {rb}✗{/} {b}The saved host key was kept: sealup.yml was not changed.{/}',
          '    A deploy to production stops before logging in while ssh.example.com',
          '    shows another key.',
          '',
          '    Nothing was changed.',
          '    {d}More: sealup.dev/e/host-key-not-replaced{/}',
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(4);
    expect(readFileSync(file, 'utf8')).toBe(config);
  });

  it('never replaces it without a terminal: S17 words and how to replace it, exit 4', async () => {
    const config = twoTargets(hostKeyLine);
    const { root, config: file } = createProject(config, build);
    const server = scanOf(otherLine);
    const run = await runMain(['keyscan', 'production'], { cwd: root, scan: server.scanHostKey });
    expect(run.stderr).toBe(
      goldenText(
        [
          'sealup 0.0.0-source · keyscan production',
          ...block(server.fingerprint),
          "  {rb}✗{/} {b}The server's host key changed. sealup.yml was not changed.{/}",
          ...changed(server.fingerprint),
          "    Ask your host for the server's fingerprint. If it is the received one, run",
          '    on a terminal:  sealup keyscan production   and answer yes.',
          '',
          '    Nothing was changed.',
          '    {d}More: sealup.dev/e/host-key-not-replaced{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(4);
    expect(readFileSync(file, 'utf8')).toBe(config);
  });

  it('in GitHub: the fix on your machine, one annotation at the hostKey line, --json', async () => {
    const { root } = createProject(twoTargets(hostKeyLine), build);
    const server = scanOf(otherLine);
    const run = await runMain(['keyscan', 'production', '--json'], {
      cwd: root,
      env: inGitHub,
      scan: server.scanHostKey,
    });
    const { masks, rest } = splitMasks(run.stderr);
    expect(masks).toBe(canaryMasks.join('\n'));
    const lines = rest.split('\n');
    expect(lines).toContain(
      "    Ask your host for the server's fingerprint. If it is the received one, on",
    );
    expect(lines).toContain(
      '    your machine:  sealup keyscan production   then commit sealup.yml.',
    );
    expect(lines).toContain(
      `::error file=sealup.yml,line=6,title=Host key changed::ssh.example.com sent ${server.fingerprint}; sealup.yml expects ${hostKeyFingerprint}. The host moved the site, or someone is intercepting. Ask your host, then run sealup keyscan production on your machine.`,
    );
    expect(JSON.parse(run.stdout)).toMatchObject({
      command: 'keyscan',
      target: 'production',
      status: 'failed',
      exitCode: 4,
      hostKey: { fingerprint: server.fingerprint, line: otherLine, state: 'changed' },
      error: { code: 'host-key-not-replaced' },
    });
    expect(run.exitCode).toBe(4);
  });
});

describe('keyscan: no key saved, on a terminal', () => {
  it('prints the line to paste on a no, exit 0, the file unchanged', async () => {
    const config = twoTargets();
    const { root, config: file } = createProject(config, build);
    const run = await runMain(['keyscan', 'production', '--json'], {
      cwd: root,
      tty: true,
      keys: ['n', enter],
      scan: scanOf().scanHostKey,
    });
    const screen = screenOf(run.stderr);
    expect(screen.slice(screen.indexOf('  Save it'))).toBe(
      goldenText(
        [
          '  Save it to sealup.yml as hostKey? [y/N] n',
          '',
          '  Nothing was saved. To trust this key later, paste this line into',
          '  sealup.yml yourself (or run sealup keyscan production again):',
          '',
          `  hostKey: ${hostKeyLine}`,
        ],
        { color: true },
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(config);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'ok', hostKey: { state: 'not-saved' } });
  });

  it.each([
    ['Esc', '\u001b'],
    ['Ctrl-C', '\u0003'],
  ])('stops on %s with exit 130, nothing written', async (_, key) => {
    const config = twoTargets();
    const { root, config: file } = createProject(config, build);
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      tty: true,
      keys: [key],
      scan: scanOf().scanHostKey,
    });
    expect(screenOf(run.stderr)).toContain('Stopped: the question was not answered.');
    expect(run.exitCode).toBe(130);
    expect(readFileSync(file, 'utf8')).toBe(config);
  });

  it('saves on a yes: --json says saved', async () => {
    const { root, config: file } = createProject(twoTargets(), build);
    const run = await runMain(['keyscan', 'production', '--json'], {
      cwd: root,
      tty: true,
      keys: ['y', enter],
      scan: scanOf().scanHostKey,
    });
    expect(run.exitCode).toBe(0);
    // After production's server: line, with its indentation.
    expect(readFileSync(file, 'utf8')).toBe(
      twoTargets().replace('home/site\n', `home/site\n    hostKey: ${hostKeyLine}\n`),
    );
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'ok', hostKey: { state: 'saved' } });
  });
});

describe('keyscan: choosing the target', () => {
  it('asks with the picker on a terminal, and saves under the target picked', async () => {
    const { root, config: file } = createProject(twoTargets(), build);
    const run = await runMain(['keyscan'], {
      cwd: root,
      tty: true,
      keys: [down, enter, 'y', enter],
      scan: scanOf().scanHostKey,
    });
    const screen = screenOf(run.stderr);
    expect(
      screen.startsWith(
        goldenText(['Scan which target?', '  {g}✓{/} staging', ''], { color: true }),
      ),
    ).toBe(true);
    expect(screen).toContain('  staging     sftp://deploy@203.0.113.10:22/srv/site');
    expect(run.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain(
      `    server: sftp://deploy@203.0.113.10/srv/site\n    hostKey: ${hostKeyLine}\n`,
    );
  });

  it('without a terminal, names every keyscan command to type: exit 2', async () => {
    const { root } = createProject(twoTargets(), build);
    const run = await runMain(['keyscan'], { cwd: root, scan: scanOf().scanHostKey });
    expect(run.stderr).toContain(
      '    sealup asks only on a terminal. Name the target in the command:\n      sealup keyscan production\n      sealup keyscan staging\n',
    );
    expect(run.exitCode).toBe(2);
  });

  it('a name not in the file: did-you-mean with the keyscan command, exit 2', async () => {
    const { root } = createProject(twoTargets(), build);
    const run = await runMain(['keyscan', 'prodution'], { cwd: root, scan: scanOf().scanHostKey });
    expect(run.stderr).toContain('sealup keyscan production');
    expect(run.exitCode).toBe(2);
  });
});

describe('keyscan reads only the server', () => {
  it('scans although the password variable is not set (staging needs STAGING_PASSWORD)', async () => {
    const { root } = createProject(twoTargets(), build);
    const run = await runMain(['keyscan', 'staging'], { cwd: root, scan: scanOf().scanHostKey });
    expect(run.stderr).toContain(`  hostKey: ${hostKeyLine}`);
    expect(run.exitCode).toBe(0);
  });

  it('stops on a server it cannot read: exit 2, the config problem, no scan', async () => {
    const config = twoTargets().replace(
      'sftp://deploy@203.0.113.10/srv/site',
      `sftp://deploy@${ref('STAGING_HOST')}/srv/site`,
    );
    const { root } = createProject(config, build);
    const run = await runMain(['keyscan', 'staging'], { cwd: root });
    expect(run.stderr).toContain('STAGING_HOST');
    expect(run.stderr).not.toContain('STAGING_PASSWORD');
    expect(run.exitCode).toBe(2);
  });

  it('says the key was not checked when the server cannot be reached: exit 5', async () => {
    const { root } = createProject(twoTargets(), build);
    const run = await runMain(['keyscan', 'production'], {
      cwd: root,
      scan: async () => {
        throw new TransportError('unreachable', 'refused');
      },
    });
    expect(run.stderr).toBe(
      goldenText(
        [
          'sealup 0.0.0-source · keyscan production',
          production,
          '  host key    {d}not checked{/}',
          '',
          '  {rb}✗{/} {b}The connection was refused on that port.{/}',
          '',
          '    Nothing was changed.',
          '    {d}More: sealup.dev/e/unreachable{/}',
        ],
        { color: false },
      ),
    );
    expect(run.exitCode).toBe(5);
  });

  it('over SFTP: no login at all, then a deploy logs in with the key it saved', async () => {
    const server = await testServer({ password: canaries.SEALUP_CANARY_PASSWORD });
    const { root } = createProject(twoTargets(), build);
    const scanned = await runMain(['keyscan', 'production'], {
      cwd: root,
      tty: true,
      keys: ['y', enter],
      scan: scanDialing(server),
    });
    expect(scanned.exitCode).toBe(0);
    expect(server.logins()).toEqual([]);
    const deployed = await runMain(['deploy', 'production'], {
      cwd: root,
      connect: dialing(server),
    });
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(server.logins()).toEqual([{ method: 'password', accepted: true }]);
  });
});
