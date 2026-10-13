// Packaging must preserve the signed payload and signatures; it cannot manufacture a
// provenance-looking filename from an unsigned statement or an unrelated attestation.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../scripts/gates.ts';
import { runNode } from './gate-kit.ts';

const script = join(repoRoot, 'scripts', 'release-provenance.ts');
const statement = {
  _type: 'https://in-toto.io/Statement/v1',
  predicateType: 'https://slsa.dev/provenance/v1',
  subject: [{ name: 'action.mjs', digest: { sha256: 'a'.repeat(64) } }],
  predicate: { buildDefinition: {}, runDetails: {} },
};
// Synthetic signature material: these tests check packaging, not cryptographic validity.
const dsse = {
  payloadType: 'application/vnd.in-toto+json',
  payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  signatures: [{ keyid: '', sig: 'c3ludGhldGlj' }],
};
const bundle = {
  mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
  verificationMaterial: { certificate: { rawBytes: 'c3ludGhldGlj' } },
  dsseEnvelope: dsse,
};

async function convert(
  input: unknown,
): Promise<{ code: number | null; bundle: string; jsonl: string }> {
  const temp = mkdtempSync(join(tmpdir(), 'sealup-provenance-'));
  try {
    const source = join(temp, 'bundle.json');
    const out = join(temp, 'release');
    mkdirSync(out);
    writeFileSync(source, JSON.stringify(input));
    const run = await runNode([script, source, out], repoRoot);
    return {
      code: run.exitCode,
      bundle: run.exitCode === 0 ? readFileSync(join(out, 'provenance.sigstore.json'), 'utf8') : '',
      jsonl: run.exitCode === 0 ? readFileSync(join(out, 'provenance.intoto.jsonl'), 'utf8') : '',
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('release provenance packaging', () => {
  it('preserves the full bundle byte for byte and the signed DSSE envelope without re-encoding', async () => {
    const result = await convert(bundle);
    expect(result.code).toBe(0);
    expect(result.bundle).toBe(JSON.stringify(bundle));
    expect(result.jsonl).toBe(`${JSON.stringify(dsse)}\n`);
    expect(
      JSON.parse(Buffer.from(JSON.parse(result.jsonl).payload, 'base64').toString('utf8')),
    ).toEqual(statement);
  });

  it.each([
    ['unsigned statement', statement],
    ['missing signatures', { ...bundle, dsseEnvelope: { ...dsse, signatures: [] } }],
    ['missing verification material', { dsseEnvelope: dsse }],
    [
      'different predicate',
      {
        ...bundle,
        dsseEnvelope: {
          ...dsse,
          payload: Buffer.from(JSON.stringify({ ...statement, predicateType: 'other' })).toString(
            'base64',
          ),
        },
      },
    ],
  ])('rejects %s', async (_, input) => {
    expect((await convert(input)).code).toBe(1);
  });
});
