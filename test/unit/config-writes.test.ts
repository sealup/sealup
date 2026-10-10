// config, `write` (decision 0022 §2 and §8, R3, R17, spec #24 decision 24): a server file written
// from a secret, short form and long form, the shared list and a target's own, and every problem
// at its place (file, line, key path), never with the value (R6).

import { describe, expect, it } from 'vitest';
import { reveal, secretForms } from '../../src/secret/index.ts';
import { issuesOf, load, ref, targetIssues, targetOf } from '../config-kit.ts';

const env = { SEALUP_PASSWORD: 'pw-1234', APP_ENV: 'APP_ENV=production\nAPP_KEY=fake-key-1\n' };

const withWrite = (...lines: string[]): string =>
  [
    'server: sftp://deploy@ssh.example.com/home/site',
    `password: ${ref('SEALUP_PASSWORD')}`,
    'upload: dist',
    ...lines,
  ].join('\n');

describe('loadConfig: write (decision 0022 §2)', () => {
  it('takes the short form: a server file from one variable, mode 0600, not public', async () => {
    const { result, file } = await load(withWrite('write:', `  api/.env: ${ref('APP_ENV')}`), env);
    const [entry, ...rest] = targetOf(result, 'ssh.example.com').writes;
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      path: 'api/.env',
      mode: 0o600,
      allowPublic: false,
      place: { file, line: 5, keyPath: 'write.api/.env' },
    });
    expect(entry?.secret.envName).toBe('APP_ENV');
    expect(String(entry?.secret)).toBe('[secret]');
    expect(entry === undefined ? '' : reveal(entry.secret)).toBe(env.APP_ENV);
  });

  it('takes the long form: from, mode as an octal string, allowPublic', async () => {
    const { result, file } = await load(
      withWrite(
        'write:',
        '  www/config.php:',
        `    from: ${ref('APP_ENV')}`,
        `    mode: '0640'`,
        '    allowPublic: true',
        '  api/.env:',
        `    from: ${ref('APP_ENV')}`,
        '    mode: "600"',
      ),
      env,
    );
    expect(targetOf(result, 'ssh.example.com').writes).toMatchObject([
      {
        path: 'www/config.php',
        mode: 0o640,
        allowPublic: true,
        place: { file, line: 5, keyPath: 'write.www/config.php' },
      },
      { path: 'api/.env', mode: 0o600, allowPublic: false, place: { line: 9 } },
    ]);
  });

  it("adds a target's own entries to the shared list", async () => {
    const { result } = await load(
      [
        'upload: dist',
        'write:',
        `  api/.env: ${ref('APP_ENV')}`,
        'targets:',
        '  production:',
        '    server: sftp://deploy@ssh.example.com/home/site',
        `    password: ${ref('SEALUP_PASSWORD')}`,
        '    write:',
        `      api/extra.env: ${ref('APP_ENV')}`,
        '  staging:',
        '    server: sftp://deploy@ssh.example.com/home/staging',
        `    password: ${ref('SEALUP_PASSWORD')}`,
      ].join('\n'),
      env,
    );
    const paths = (name: string) => targetOf(result, name).writes.map((entry) => entry.path);
    expect(paths('production')).toEqual(['api/.env', 'api/extra.env']);
    expect(paths('staging')).toEqual(['api/.env']);
    expect(targetOf(result, 'production').writes[1]?.place).toMatchObject({
      line: 9,
      keyPath: 'targets.production.write.api/extra.env',
    });
  });

  it('gives every write secret to the masks, each line of a multi-line value included', async () => {
    const { result } = await load(withWrite('write:', `  api/.env: ${ref('APP_ENV')}`), env);
    const forms = secretForms(result.secrets);
    expect(forms).toContain(env.APP_ENV);
    expect(forms).toContain('APP_ENV=production');
    expect(forms).toContain('APP_KEY=fake-key-1');
  });

  it('allows line breaks in the value: it is a file, not a credential (R4)', async () => {
    const { result } = await load(withWrite('write:', `  .env: ${ref('APP_ENV')}`), {
      ...env,
      APP_ENV: '\nA=1\r\nB=2\n',
    });
    expect(targetOf(result, 'ssh.example.com').writes).toHaveLength(1);
  });
});

describe('loadConfig: write problems, at their place, never with the value (R3, R6)', () => {
  it.each([
    ['a literal', 'APP_KEY=fake-literal'],
    ['a literal around a variable', `A=${ref('APP_ENV')}`],
    ['two variables', `${ref('APP_ENV')}${ref('SEALUP_PASSWORD')}`],
  ])('refuses %s as secret-in-config, for every run', async (_, value) => {
    const { result, file } = await load(withWrite('write:', `  api/.env: "${value}"`), env);
    expect(issuesOf(result)).toEqual([
      { code: 'secret-in-config', file, line: 5, keyPath: 'write.api/.env', detail: 'write' },
    ]);
    expect(JSON.stringify(issuesOf(result))).not.toContain('fake-literal');
  });

  it('refuses a literal in the long form, and masks it all the same', async () => {
    const { result } = await load(
      withWrite('write:', '  api/.env:', '    from: APP_KEY=fake-literal'),
      env,
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'secret-in-config', line: 6, keyPath: 'write.api/.env.from' },
    ]);
    expect(secretForms(result.secrets)).toContain('APP_KEY=fake-literal');
  });

  it('stops a run to the target when the variable is not set', async () => {
    const { result } = await load(withWrite('write:', `  api/.env: ${ref('NOPE')}`), env);
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      { code: 'variable-not-set', line: 5, keyPath: 'write.api/.env', variable: 'NOPE' },
    ]);
  });

  it('refuses a value under 6 characters (R2)', async () => {
    const { result } = await load(withWrite('write:', `  api/.env: ${ref('APP_ENV')}`), {
      ...env,
      APP_ENV: 'A=1\n',
    });
    expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
      {
        code: 'secret-refused',
        line: 5,
        keyPath: 'write.api/.env',
        variable: 'APP_ENV',
        reason: 'too-short',
      },
    ]);
  });

  it.each(['../.env', '/etc/app.env', '.', 'api/../.env'])(
    'refuses the server path %s: a file path in the target folder (R10)',
    async (path) => {
      const { result } = await load(withWrite('write:', `  "${path}": ${ref('APP_ENV')}`), env);
      expect(targetIssues(result, 'ssh.example.com')).toMatchObject([
        { code: 'remote-path', line: 5, detail: 'file' },
      ]);
    },
  );

  it.each([
    ['a YAML number', 'mode: 0640'],
    ['not octal', `mode: '0980'`],
    ['too long', `mode: '10640'`],
  ])('refuses a mode written as %s', async (_, line) => {
    const { result } = await load(
      withWrite('write:', '  api/.env:', `    from: ${ref('APP_ENV')}`, `    ${line}`),
      env,
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 7, keyPath: 'write.api/.env.mode', expected: 'mode' },
    ]);
  });

  it('refuses allowPublic other than true or false', async () => {
    const { result } = await load(
      withWrite('write:', '  api/.env:', `    from: ${ref('APP_ENV')}`, '    allowPublic: yes'),
      env,
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'wrong-type', line: 7, keyPath: 'write.api/.env.allowPublic', expected: 'yes-no' },
    ]);
  });

  it('refuses a write that is not a map, and an entry of the wrong shape', async () => {
    const list = await load(withWrite('write: [api/.env]'), env);
    expect(issuesOf(list.result)).toMatchObject([
      { code: 'wrong-type', line: 4, keyPath: 'write', expected: 'write' },
    ]);
    const entry = await load(withWrite('write:', '  api/.env: 12'), env);
    expect(issuesOf(entry.result)).toMatchObject([
      { code: 'wrong-type', line: 5, keyPath: 'write.api/.env', expected: 'write-entry' },
    ]);
  });

  it('refuses an unknown key and a missing from in the long form', async () => {
    const { result } = await load(
      withWrite('write:', '  api/.env:', '    mode: "0600"', '    owner: www-data'),
      env,
    );
    expect(issuesOf(result)).toMatchObject([
      { code: 'missing-key', keyPath: 'write.api/.env.from' },
      { code: 'unknown-key', line: 7, keyPath: 'write.api/.env.owner' },
    ]);
  });
});
