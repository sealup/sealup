// Bites: the leak harness (R1): a program that leaks a canary secret in one encoded form.
// Placed at: test/gates/bad/leak/print-canary.ts (run in place, never copied)
// Expect: the harness reports the place and the form
//
//   node print-canary.ts <place> <form> [file]
//   place: stdout | stderr | json | file   form: see `encode` below
// The canary comes from the environment, as a real CLI would read it.

import { writeFileSync } from 'node:fs';

const [place, form, file] = process.argv.slice(2);
const password = process.env.SEALUP_CANARY_PASSWORD ?? '';
const multiline = process.env.SEALUP_CANARY_MULTILINE ?? '';

function encode(): string {
  switch (form) {
    case 'raw':
      return password;
    case 'json-escaped':
      return JSON.stringify(password).slice(1, -1);
    case 'url-encoded':
      return encodeURIComponent(password);
    case 'form-encoded':
      return new URLSearchParams({ p: password }).toString().slice(2);
    case 'base64':
      return Buffer.from(password).toString('base64');
    case 'base64url':
      return Buffer.from(password).toString('base64url');
    case 'basic-auth':
      // `user:password` in base64: the secret starts at an offset inside the encoded bytes.
      return Buffer.from(`deploy:${password}`).toString('base64');
    case 'hex':
      return Buffer.from(password).toString('hex');
    case 'hex-upper':
      return Buffer.from(password).toString('hex').toUpperCase();
    case 'second-line':
      return multiline.split('\n')[1] ?? '';
    case 'key-line':
      // One line from the middle of the canary private key, as a stack or a dump might show it.
      return (process.env.SEALUP_CANARY_KEY ?? '').split('\n')[2] ?? '';
    case 'redacted':
      return '[secret]';
    default:
      throw new Error(`unknown form ${form}`);
  }
}

const text = `login failed for deploy with ${encode()} at sftp://deploy@ssh.example.com\n`;
if (place === 'stdout') process.stdout.write(text);
else if (place === 'stderr') process.stderr.write(text);
else if (place === 'json') process.stdout.write(`${JSON.stringify({ error: { message: text } })}\n`);
else if (place === 'file' && file !== undefined) writeFileSync(file, text);
