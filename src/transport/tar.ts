// The tar packer (spec #41 decision 14): files packed into one gzip tar stream, for the SSH
// archive. Pack only, no child process (R5), no library (0012): ustar headers, gzip by node:zlib.

import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { pipeline, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { type RemotePath, type ServerPath, TransportError } from '../contracts/index.ts';
import { joinServer } from '../paths/index.ts';

/** One file to pack. */
export interface TarEntry {
  /** Its name in the archive, relative to the folder it is extracted into. */
  readonly name: RemotePath;
  /**
   * Its bytes: a local file of `size` bytes (the size the plan counted; read when its turn
   * comes), or bytes in memory.
   */
  readonly source:
    | { readonly file: string; readonly size: number }
    | { readonly bytes: Uint8Array };
  /** Permission bits (`0o644`). */
  readonly mode: number;
  /** Modification time, whole seconds since 1970. */
  readonly mtime: number;
}

const block = 512;
/** Bytes read from a local file at a time. */
const readSize = 64 * 1024;

/**
 * Packs `entries`, in order, into one gzip tar stream; `root` is where it will be extracted (for
 * the path of a TransportError). Nothing is read before the stream is: one file is open at a
 * time, one chunk of it in memory. A local file that is not the size given fails the stream with
 * `changed`; one that cannot be read, with the disk's error.
 */
export function packTar(root: ServerPath, entries: Iterable<TarEntry>): Readable {
  return pipeline(Readable.from(blocks(root, entries), { objectMode: false }), createGzip(), () => {
    // pipeline destroys the gzip stream with the first error: its reader gets it.
  });
}

async function* blocks(root: ServerPath, entries: Iterable<TarEntry>): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const { source } = entry;
    const size = 'file' in source ? source.size : source.bytes.length;
    let name: string = entry.name;
    if (!fitsUstar(name)) {
      const records = paxRecord('path', name);
      yield header(paxName, records.length, entry, 'x');
      yield records;
      yield padding(records.length);
      name = longName;
    }
    if ('file' in source) {
      const changed = () =>
        new TransportError('protocol', 'changed', {
          operation: 'upload',
          path: joinServer(root, entry.name),
        });
      const file = await open(source.file, 'r');
      try {
        if ((await file.stat()).size !== size) throw changed();
        yield header(name, size, entry, '0');
        for (let at = 0; at < size; ) {
          const { bytesRead, buffer } = await file.read(
            Buffer.alloc(Math.min(readSize, size - at)),
          );
          if (bytesRead === 0) throw changed();
          yield buffer.subarray(0, bytesRead);
          at += bytesRead;
        }
      } finally {
        await file.close();
      }
    } else {
      yield header(name, size, entry, '0');
      yield Buffer.from(source.bytes.buffer, source.bytes.byteOffset, size);
    }
    yield padding(size);
  }
  yield Buffer.alloc(2 * block);
}

/**
 * The ustar name of a PAX header, and of the file after it: plain ASCII, so a reader that skips
 * PAX extracts a harmless name inside the folder, never a cut-off path.
 */
const paxName = 'PaxHeader';
const longName = 'LongName';

/** Whether a name goes in ustar's 100-byte name field as it is: ASCII and short enough. */
function fitsUstar(name: string): boolean {
  return name.length <= 100 && /^[\x20-\x7e]*$/.test(name);
}

/** One PAX record, `<length> <key>=<value>\n`, the length counting the whole record in bytes. */
function paxRecord(key: string, value: string): Buffer {
  const rest = Buffer.byteLength(` ${key}=${value}\n`, 'utf8');
  let length = rest + String(rest).length;
  if (String(length).length + rest !== length) length += 1;
  return Buffer.from(`${length} ${key}=${value}\n`, 'utf8');
}

/** A ustar header block: a regular file (`0`) or a PAX extended header (`x`). */
function header(name: string, size: number, entry: TarEntry, type: '0' | 'x'): Buffer {
  const out = Buffer.alloc(block);
  out.write(name, 0, 100, 'latin1');
  writeOctal(out, 100, 8, entry.mode);
  writeOctal(out, 108, 8, 0);
  writeOctal(out, 116, 8, 0);
  writeOctal(out, 124, 12, size);
  writeOctal(out, 136, 12, entry.mtime);
  out.write(type, 156, 'latin1');
  out.write('ustar\u000000', 257, 'latin1');
  out.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of out) sum += byte;
  writeOctal(out, 148, 7, sum);
  return out;
}

/**
 * Writes `value` as zero-padded octal digits filling `length - 1` bytes, then a NUL. A value the
 * field cannot hold (negative, fractional, too large: a size of 8 GiB, a time after 2242) throws
 * a RangeError rather than writing a header no tar reads right.
 */
function writeOctal(out: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 8 ** (length - 1)) {
    throw new RangeError(`tar: ${value} does not fit a ${length}-byte header field`);
  }
  out.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'latin1');
}

/** The zeros that fill the last block of `size` bytes of data. */
function padding(size: number): Buffer {
  return Buffer.alloc((block - (size % block)) % block);
}
