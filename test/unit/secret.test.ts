// Secrets stay out of every output (R1, R4, decision 0019).

import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Secret } from '../../src/contracts/index.ts';
import {
  createFileSecret,
  createSecret,
  redact,
  reveal,
  sameAsSecret,
  secretForms,
  secretSize,
} from '../../src/secret/index.ts';

// A fake value with the characters that change under encodings (exploration 03, spike redaction).
const canary = 'fake-P@ss"w0rd/+=&%\\\'$canary';

function secretOf(value: string, envName = 'SITE_PASSWORD'): Secret {
  const result = createSecret(envName, value);
  if (!result.ok) throw new Error(`test setup: refused (${result.problem})`);
  return result.secret;
}

describe('a Secret prints as [secret]', () => {
  const secret = secretOf(canary);

  it.each([
    ['String()', () => String(secret)],
    ['a template literal', () => `${secret}`],
    ['toString()', () => secret.toString()],
    ['concatenation', () => `x${String(secret)}`],
    ['JSON.stringify', () => JSON.stringify({ password: secret })],
    ['util.inspect', () => inspect(secret)],
    ['util.inspect, nested', () => inspect({ a: { b: { c: [secret] } } }, { depth: 10 })],
    ['util.inspect, showHidden', () => inspect(secret, { showHidden: true, depth: 10 })],
    ['util.format %s %o %O %j', () => format('%s %o %O %j', secret, secret, secret, { secret })],
  ])('through %s', (_, print) => {
    const printed = print();
    expect(printed).toContain('[secret]');
    expect(printed).not.toContain('canary');
  });

  it('holds no readable copy of the value', () => {
    const own = Reflect.ownKeys(secret).map((key) => String(Reflect.get(secret, key)));
    expect(own.join(' ')).not.toContain('canary');
    expect(Object.isFrozen(secret)).toBe(true);
  });

  it('keeps the name of its variable, for messages that cite places (R6)', () => {
    expect(secret.envName).toBe('SITE_PASSWORD');
  });
});

describe('reveal', () => {
  it('gives the value back', () => {
    expect(reveal(secretOf(canary))).toBe(canary);
  });

  it('refuses a Secret it did not make', () => {
    const forged: Secret = {
      envName: 'X',
      toString: () => '[secret]',
      toJSON: () => '[secret]',
    };
    expect(() => reveal(forged)).toThrow(TypeError);
  });
});

describe('createSecret refuses malformed credentials (R4)', () => {
  it.each([
    ['fake-pass\n', 'forbidden-character'],
    ['fake\r\npass', 'forbidden-character'],
    ['fake\rpass', 'forbidden-character'],
    ['fake\u0000pass', 'forbidden-character'],
    [' fake-pass', 'surrounding-whitespace'],
    ['fake-pass\t', 'surrounding-whitespace'],
  ])('%j (%s), without the value in the result', (value, problem) => {
    const result = createSecret('SITE_PASSWORD', value);
    expect(result).toEqual({ ok: false, problem });
  });

  it('accepts inner spaces and every printable character', () => {
    expect(createSecret('P', 'a b " \' $ / + = % \\ é').ok).toBe(true);
  });

  it('names the unsafe character, not the length, when a short value has one', () => {
    expect(createSecret('P', 'a\nb')).toEqual({ ok: false, problem: 'forbidden-character' });
  });
});

describe('createSecret refuses a value under 6 characters (R2)', () => {
  it.each([
    ['', 'empty'],
    ['abc12', 'five characters'],
    ['ééééé', 'five characters, ten bytes'],
    ['🔑🔑🔑', 'three characters, six UTF-16 units'],
  ])('%j (%s), without the value in the result', (value) => {
    expect(createSecret('SITE_PASSWORD', value)).toEqual({ ok: false, problem: 'too-short' });
  });

  it('accepts 6 characters', () => {
    expect(createSecret('SITE_PASSWORD', 'abc123').ok).toBe(true);
    expect(createSecret('SITE_PASSWORD', '🔑🔑🔑🔑🔑🔑').ok).toBe(true);
  });
});

describe('redact removes every known secret and its derived forms (R1)', () => {
  const value = `${canary}-redact`;
  secretOf(value, 'OTHER_PASSWORD');
  const bytes = Buffer.from(value, 'utf8');

  it.each([
    ['exact', value],
    ['base64', bytes.toString('base64')],
    ['base64url', bytes.toString('base64url')],
    ['URL-encoded', encodeURIComponent(value)],
    ['JSON-escaped', JSON.stringify(value).slice(1, -1)],
    ['hex', bytes.toString('hex')],
    ['HEX', bytes.toString('hex').toUpperCase()],
  ])('%s', (_, form) => {
    const text = `before ${form} middle ${form} after`;
    expect(redact(text)).toBe('before [secret] middle [secret] after');
  });

  it('masks every secret made so far, not only the last one', () => {
    const first = secretOf('fake-first-value');
    const second = secretOf('fake-second-value');
    expect(redact('fake-first-value, fake-second-value')).toBe('[secret], [secret]');
    expect(reveal(first)).toBe('fake-first-value');
    expect(reveal(second)).toBe('fake-second-value');
  });

  it('masks the longer secret first when one contains another', () => {
    secretOf('fake-short');
    secretOf('fake-short-and-longer');
    expect(redact('x fake-short-and-longer y fake-short z')).toBe('x [secret] y [secret] z');
  });

  it('leaves text without secrets as it is', () => {
    const text = 'Sealed up and delivered: 3 files to production in 1.2 s.\n';
    expect(redact(text)).toBe(text);
  });
});

describe('a file written from a secret (R17): its content, line breaks allowed', () => {
  const content =
    'APP_ENV=production\nAPP_KEY=fake-base64:Zm9vYmFy\r\nDB=x\n  DB_PASSWORD=fake-db-pw  \n';

  function fileSecretOf(value: string): Secret {
    const result = createFileSecret('APP_ENV', value);
    if (!result.ok) throw new Error(`test setup: refused (${result.problem})`);
    return result.secret;
  }

  it('takes a multi-line value, and gives it back whole', () => {
    expect(reveal(fileSecretOf(content))).toBe(content);
  });

  it('refuses a value under 6 characters, counting the whole value (R2)', () => {
    expect(createFileSecret('APP_ENV', 'a=1\n')).toEqual({ ok: false, problem: 'too-short' });
    expect(createFileSecret('APP_ENV', 'a=1\nb=2\n').ok).toBe(true);
  });

  it('is redacted whole, and line by line for each line of 6 characters or more', () => {
    fileSecretOf(content);
    expect(redact(`[${content}]`)).toBe('[[secret]]');
    expect(redact('read APP_KEY=fake-base64:Zm9vYmFy here')).toBe('read [secret] here');
    expect(redact('read DB_PASSWORD=fake-db-pw, ok')).toBe('read [secret], ok');
    // A line under 6 characters is too short to mask; the lines' own encodings are covered.
    expect(redact('DB=x')).toBe('DB=x');
    expect(redact(Buffer.from('APP_ENV=production').toString('base64'))).toBe('[secret]');
  });

  it("gives GitHub's masks for the value and each line of 6 characters or more", () => {
    const forms = secretForms([fileSecretOf(content)]);
    expect(forms[0]).toBe(content);
    expect(forms).toContain('APP_ENV=production');
    expect(forms).toContain('APP_KEY=fake-base64:Zm9vYmFy');
    expect(forms).toContain('DB_PASSWORD=fake-db-pw');
    expect(forms).not.toContain('DB=x');
  });

  it('gives a one-line value no extra line forms', () => {
    const forms = secretForms([fileSecretOf('fake-one-line-file')]);
    expect(forms.filter((form) => form === 'fake-one-line-file')).toHaveLength(1);
  });

  it('compares with bytes read back, without giving the value out', () => {
    const secret = fileSecretOf('KEY=fake-é-value\n');
    expect(secretSize(secret)).toBe(Buffer.byteLength('KEY=fake-é-value\n'));
    expect(sameAsSecret(secret, Buffer.from('KEY=fake-é-value\n'))).toBe(true);
    expect(sameAsSecret(secret, Buffer.from('KEY=fake-é-value'))).toBe(false);
    expect(sameAsSecret(secret, Buffer.from('KEY=fake-e-value\n'))).toBe(false);
  });
});

describe('a value hidden in GitHub’s form only (decision 0045)', () => {
  it('gets the forms of a secret, after the secrets, once each', () => {
    const forms = secretForms([secretOf('fake-pw-for-forms')], ['hidden-host.example.com']);
    expect(forms.indexOf('fake-pw-for-forms')).toBe(0);
    expect(forms).toContain('hidden-host.example.com');
    expect(forms).toContain(Buffer.from('hidden-host.example.com').toString('base64'));
    expect(forms).toContain(Buffer.from('hidden-host.example.com').toString('hex'));
    expect(forms.indexOf('hidden-host.example.com')).toBeGreaterThan(0);
    expect(new Set(forms).size).toBe(forms.length);
  });

  it('is masked as it is only when under 6 characters: its encodings would hide too much', () => {
    expect(secretForms([], ['web'])).toEqual(['web']);
  });

  it('is never redacted: a terminal shows it (R22)', () => {
    secretForms([], ['shown-on-a-terminal.example.com']);
    expect(redact('sftp://shown-on-a-terminal.example.com')).toBe(
      'sftp://shown-on-a-terminal.example.com',
    );
  });
});
