// Attach the signed provenance produced by actions/attest-build-provenance to the release.
// Keep the Sigstore bundle intact for verification; export its signed DSSE envelope as one
// JSONL record, the in-toto format Scorecard discovers. This converts packaging only: it does
// not create signatures or claim to verify them.
//
//   node scripts/release-provenance.ts <bundle> <existing release assets folder>

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envelope(text: string): Record<string, unknown> {
  const bundle: unknown = JSON.parse(text);
  const dsse = record(bundle) ? bundle.dsseEnvelope : undefined;
  if (
    !record(bundle) ||
    !record(bundle.verificationMaterial) ||
    !record(dsse) ||
    dsse.payloadType !== 'application/vnd.in-toto+json' ||
    typeof dsse.payload !== 'string' ||
    !Array.isArray(dsse.signatures) ||
    dsse.signatures.length === 0 ||
    !dsse.signatures.every((s: unknown) => record(s) && typeof s.sig === 'string' && s.sig !== '')
  ) {
    throw new Error('expected a Sigstore bundle containing signed in-toto provenance');
  }
  const statement: unknown = JSON.parse(Buffer.from(dsse.payload, 'base64').toString('utf8'));
  if (
    !record(statement) ||
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !Array.isArray(statement.subject) ||
    statement.subject.length === 0
  ) {
    throw new Error('expected a SLSA v1 provenance statement with artifact subjects');
  }
  return dsse;
}

const [bundle, out] = process.argv.slice(2);
if (bundle === undefined || out === undefined || process.argv.length !== 4) {
  console.error('usage: node scripts/release-provenance.ts <bundle> <release assets folder>');
  process.exitCode = 2;
} else {
  try {
    const source = resolve(bundle);
    const target = resolve(out);
    const dsse = envelope(readFileSync(source, 'utf8'));
    copyFileSync(source, join(target, 'provenance.sigstore.json'));
    writeFileSync(join(target, 'provenance.intoto.jsonl'), `${JSON.stringify(dsse)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
