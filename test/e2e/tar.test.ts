// The tar packer against real tars (spec #41 decision 14): one archive, extracted by GNU tar
// (Debian) and by busybox tar (Alpine) in containers, as a shared host's user would (not root,
// umask 022) with the SSH archive's form less its `-m` (so the packed dates are checked too),
// `tar -xzf - -C <folder>`. Each container lists what it extracted (mode, size, time, SHA-256,
// name, computed there); both lists must be the packed files exactly. Names include quotes,
// spaces, `-rf`, `$(…)`, an option, non-ASCII and 200+ characters (R15: a name is never anything
// but a name).
//
// Runs where Docker runs Linux containers: always on Linux (a missing Docker fails the run), on
// other systems only when Docker answers with Linux (so Windows CI skips it). Both images are
// pinned by digest (2026-10-08).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RemotePath, ServerPath } from '../../src/contracts/index.ts';
import { packTar, type TarEntry } from '../../src/transport/index.ts';
import { dockerRunsLinux } from '../openssh-kit.ts';

const enabled = process.platform === 'linux' || dockerRunsLinux();

const tars = {
  'GNU tar':
    'debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f',
  'busybox tar':
    'alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6',
} as const;

/** Extracts the archive from stdin as user 1000, then lists every file, one line each. */
const script = [
  'set -e',
  'umask 022',
  'mkdir /tmp/site',
  'tar -xzf - -C /tmp/site',
  'cd /tmp/site',
  `find . -type f -exec sh -c 'for f; do printf "%s %s %s %s %s\\n" "$(stat -c %a "$f")" "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$(sha256sum < "$f" | cut -c1-64)" "$f"; done' sh {} +`,
].join('\n');

interface Extracted {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly sha256: string;
}

/** Runs the script in a fresh container of `image`, the archive on its stdin. */
function extractIn(image: string, archive: Uint8Array): Promise<Extracted[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['run', '--rm', '--interactive', '--user', '1000:1000', image, 'sh', '-c', script],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${image} failed (${code}): ${stderr.trim()}`));
        return;
      }
      const files = stdout
        .split('\n')
        .filter((row) => row !== '')
        .map((row) => {
          const [mode = '', size = '', mtime = '', sha256 = ''] = row.split(' ', 4);
          const name = row.slice([mode, size, mtime, sha256].join(' ').length + 1);
          return {
            name: name.replace(/^\.\//, ''),
            mode: Number.parseInt(mode, 8),
            size: Number(size),
            mtime: Number(mtime),
            sha256,
          };
        });
      resolve(files.sort((a, b) => (a.name < b.name ? -1 : 1)));
    });
    child.stdin.end(archive);
  });
}

describe.runIf(enabled)('tar packer, extracted by real tars in containers', () => {
  let folder = '';
  let archive: Uint8Array = new Uint8Array();
  let expected: Extracted[] = [];

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'sealup-tar-e2e-'));
    const bytes = (seed: number, size: number) =>
      Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed * 7 + (i >> 8)) % 256);
    const big = join(folder, 'big.bin');
    writeFileSync(big, bytes(1, 2_000_000));
    const named: [string, Uint8Array, number][] = [
      ['index.html', new TextEncoder().encode('<h1>home</h1>\n'), 0o644],
      ['empty.txt', new Uint8Array(), 0o644],
      [`it's "quoted".txt`, bytes(2, 700), 0o644],
      ['my pages/about us.html', bytes(3, 513), 0o644],
      ['-rf', bytes(4, 10), 0o644],
      ['--checkpoint-action=exec=sh', bytes(5, 10), 0o644],
      ['$(touch pwned)', bytes(6, 10), 0o644],
      ['`id`; rm -rf ~', bytes(7, 10), 0o644],
      ['bin/run.sh', bytes(8, 100), 0o755],
      ['api/.env.example', bytes(9, 30), 0o600],
      ['café/naïve 日本.txt', bytes(10, 40), 0o640],
      [`${'n'.repeat(230)}.html`, bytes(11, 50), 0o644],
      [
        `deep/${'folder-'.repeat(12)}/${'x'.repeat(150)}/${'y'.repeat(120)}.js`,
        bytes(12, 60),
        0o644,
      ],
    ];
    const entries: TarEntry[] = [
      ...named.map(([name, data, mode], i) => ({
        name: name as RemotePath,
        source: { bytes: data },
        mode,
        mtime: 1_700_000_000 + i,
      })),
      {
        name: 'assets/big.bin' as RemotePath,
        source: { file: big, size: 2_000_000 },
        mode: 0o644,
        mtime: 1_600_000_000,
      },
    ];
    const chunks: Buffer[] = [];
    for await (const chunk of packTar('/tmp/site' as ServerPath, entries)) chunks.push(chunk);
    archive = Buffer.concat(chunks);
    const all: [string, Uint8Array, number, number][] = [
      ...named.map(([name, data, mode], i): [string, Uint8Array, number, number] => [
        name,
        data,
        mode,
        1_700_000_000 + i,
      ]),
      ['assets/big.bin', bytes(1, 2_000_000), 0o644, 1_600_000_000],
    ];
    expected = all
      .map(([name, data, mode, mtime]) => ({
        name,
        mode,
        size: data.length,
        mtime,
        sha256: createHash('sha256').update(data).digest('hex'),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  for (const [tar, image] of Object.entries(tars)) {
    it(`${tar} extracts every file with its name, bytes, mode and time`, async () => {
      expect(await extractIn(image, archive)).toEqual(expected);
    });
  }
});
