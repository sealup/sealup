// A strict tar reader for tests (spec #41 decision 14): it reads transport's gzip tar stream back
// and refuses anything a careful reader would, so a packer bug shows here before it reaches a
// server. Reads what the packer writes: ustar headers (magic `ustar\0`, version `00`, checksum
// checked), PAX extended headers (`x`, records `<length> <key>=<value>\n` with exact lengths;
// `path` and `size` applied to the next file), regular files (`0`), and the end of the archive
// (two zero blocks, then only zeros). Any other entry type, a bad checksum, a record whose length
// is wrong, a non-zero padding byte or a missing end throws.

import { gunzipSync } from 'node:zlib';

/** One file read back from an archive. */
export interface TarFile {
  /** The name, PAX `path` first, else ustar's prefix and name. */
  readonly name: string;
  readonly size: number;
  /** Permission bits, as the header gives them. */
  readonly mode: number;
  /** Modification time, whole seconds since 1970. */
  readonly mtime: number;
  readonly bytes: Uint8Array;
}

const block = 512;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Reads a gzip tar archive: the files, in archive order. */
export function readTar(gzipped: Uint8Array): TarFile[] {
  const tar = gunzipSync(gzipped);
  if (tar.length % block !== 0) throw new Error(`tar: ${tar.length} bytes, not whole blocks`);
  const files: TarFile[] = [];
  let pax: Map<string, string> | undefined;
  let at = 0;
  while (true) {
    if (at + block > tar.length) throw new Error('tar: no end-of-archive blocks');
    const header = tar.subarray(at, at + block);
    if (header.every((byte) => byte === 0)) {
      const rest = tar.subarray(at + block);
      if (rest.length < block || !rest.every((byte) => byte === 0)) {
        throw new Error('tar: one zero block, then something else');
      }
      return files;
    }
    checkHeader(header, at);
    const type = String.fromCharCode(header[156] ?? 0);
    const headerSize = octal(header, 124, 12);
    const size = type === 'x' ? headerSize : Number(pax?.get('size') ?? headerSize);
    const start = at + block;
    const end = start + size;
    const padded = start + Math.ceil(size / block) * block;
    if (padded > tar.length) throw new Error(`tar: entry at ${at} runs past the end`);
    if (!tar.subarray(end, padded).every((byte) => byte === 0)) {
      throw new Error(`tar: non-zero padding after the entry at ${at}`);
    }
    const data = tar.subarray(start, end);
    if (type === 'x') {
      if (pax !== undefined) throw new Error(`tar: two PAX headers in a row at ${at}`);
      pax = paxRecords(data);
    } else if (type === '0' || type === '\0') {
      const prefix = text(header, 345, 155);
      const name = pax?.get('path') ?? (prefix === '' ? '' : `${prefix}/`) + text(header, 0, 100);
      files.push({
        name,
        size,
        mode: octal(header, 100, 8),
        mtime: octal(header, 136, 12),
        bytes: Uint8Array.from(data),
      });
      pax = undefined;
    } else {
      throw new Error(`tar: entry type ${JSON.stringify(type)} at ${at}`);
    }
    at = padded;
  }
}

/** Checks the magic, the version and the checksum (the field counted as eight spaces). */
function checkHeader(header: Uint8Array, at: number): void {
  if (text(header, 257, 6) !== 'ustar' || header[262] !== 0) {
    throw new Error(`tar: no ustar magic at ${at}`);
  }
  if (header[263] !== 0x30 || header[264] !== 0x30) throw new Error(`tar: version at ${at}`);
  let sum = 0;
  for (let i = 0; i < block; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  if (octal(header, 148, 8) !== sum) throw new Error(`tar: bad checksum at ${at}`);
}

/** A NUL-terminated (or full) text field. */
function text(header: Uint8Array, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return decoder.decode(nul === -1 ? field : field.subarray(0, nul));
}

/** An octal number field: digits, then NUL or space; nothing else. */
function octal(header: Uint8Array, offset: number, length: number): number {
  const field = String.fromCharCode(...header.subarray(offset, offset + length));
  const match = /^([0-7]+)[\0 ]+$/.exec(field);
  if (match?.[1] === undefined) throw new Error(`tar: bad number field ${JSON.stringify(field)}`);
  return Number.parseInt(match[1], 8);
}

/** PAX records: `<length> <key>=<value>\n`, the length counting the whole record in bytes. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw new Error('tar: PAX record without a length');
    const length = Number(decoder.decode(data.subarray(at, space)));
    if (!Number.isInteger(length) || length <= 0 || data[at + length - 1] !== 0x0a) {
      throw new Error('tar: PAX record length is wrong');
    }
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('tar: PAX record without a key');
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}
