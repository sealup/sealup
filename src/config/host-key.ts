// `hostKey`: one OpenSSH public key line, `<type> <base64>[ comment]`, as `keyscan` writes it.
// The blob must start with its own type name (the SSH wire format), so a truncated or pasted
// fingerprint is refused here, not at connect. Its fingerprint is the OpenSSH SHA-256 form.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { HostKey } from '../contracts/index.ts';

const line = /^(?<type>[a-z0-9][a-z0-9@.-]*) (?<key>[A-Za-z0-9+/]+={0,2})(?: [^\p{Cc}]*)?$/u;

export function parseHostKey(text: string): HostKey | undefined {
  const groups = line.exec(text.trim())?.groups;
  const type = groups?.type;
  const key = groups?.key;
  if (type === undefined || key === undefined) return undefined;
  const blob = Buffer.from(key, 'base64');
  if (blob.toString('base64') !== key || blob.length < 4) return undefined;
  const typeLength = blob.readUInt32BE(0);
  if (blob.subarray(4, 4 + typeLength).toString('latin1') !== type) return undefined;
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { type, key, fingerprint: `SHA256:${digest}` };
}
