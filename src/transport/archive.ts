// The SSH archive (0034, spec #41 decisions 13 and 15): the `tar` probe after login, and the
// ArchiveUpload that packs files with our own packer (tar.ts) and streams them into the one
// fixed remote command, `tar -xmzf - -C '<root>'`, over an exec channel of the connection the
// SFTP channels use. File names travel inside the archive only (R15); no local process (R5).

import type { Readable } from 'node:stream';
import type { Client, ClientChannel } from 'ssh2';
import {
  type ArchiveFile,
  type ArchiveUpload,
  type ServerPath,
  TransportError,
} from '../contracts/index.ts';
import { inCommandSet, parseServerPath } from '../paths/index.ts';
import { connectionLost } from './requests.ts';
import { packTar, type TarEntry } from './tar.ts';

/**
 * The probe after login, a fixed command (R15, 0039): the marker on stdout, and exit 0, only when
 * the shell finds both `tar` and the `gzip` that `tar -z` runs. Exit 0 alone proves nothing: an
 * account whose every command runs the sftp-server program (ForceCommand) exits 0 once its stdin ends.
 */
const archiveProbe =
  'command -v tar >/dev/null && command -v gzip >/dev/null && echo sealup-archive-ok';
const probeMarker = 'sealup-archive-ok';

/** Bytes of the probe's stdout kept: the marker and its line break, with room to spare. */
const maxProbeOutput = 256;

/** Bytes of `tar`'s stderr kept for the error (R21: a limit on everything from the server). */
const maxStderr = 64 * 1024;

/** The permission bits each file is packed with; the server's `tar` applies its umask. */
const fileMode = 0o644;

/**
 * R15: the one remote command, for one target root. The root must be an absolute server path
 * (R10) within the strict character set; it is then single-quoted, so even a character the set
 * let through by mistake would stay inside the quotes. Anything else is a bug: it throws.
 */
export function tarCommand(root: string): string {
  if (!parseServerPath(root).ok || !inCommandSet(root)) {
    throw new RangeError('the archive root is outside the characters a command may hold');
  }
  return `tar -xmzf - -C '${root}'`;
}

/**
 * Runs the probe on a new exec channel: true when it prints the marker and exits 0 within
 * `timeoutMs`. Its stdin is ended at once, so a program that reads it (an SFTP server) ends too.
 * A server that refuses exec (no shell), answers otherwise, closes the channel or says nothing
 * until `timeoutMs` gives false, never an error; the channel is closed whatever the answer.
 */
export function probeTar(client: Client, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let opened: ClientChannel | undefined;
    const finish = (has: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(bound);
      opened?.close();
      resolve(has);
    };
    const bound = setTimeout(() => finish(false), timeoutMs);
    try {
      client.exec(archiveProbe, (error, channel) => {
        if (error) {
          finish(false);
          return;
        }
        opened = channel;
        if (done) {
          // Opened after the timeout: closed at once.
          channel.close();
          return;
        }
        let code: number | undefined;
        let stdout = '';
        channel.on('exit', (exit: number | null) => {
          code = exit ?? undefined;
        });
        channel.on('data', (chunk: Buffer) => {
          if (stdout.length < maxProbeOutput) {
            stdout += chunk.toString('latin1').slice(0, maxProbeOutput);
          }
        });
        channel.on('close', () =>
          finish(code === 0 && stdout.split('\n').some((line) => line.trim() === probeMarker)),
        );
        channel.on('error', () => finish(false));
        channel.stderr.resume();
        channel.end();
      });
    } catch {
      finish(false);
    }
  });
}

/**
 * The most streams one archive is spread over (0039): a shared host's `tar` creates files one
 * after the other, each a few storage round trips, so a few side by side divide that time. Four
 * stay well under OpenSSH's 10 sessions a connection beside the SFTP channels.
 */
const maxStreams = 4;

/** Files per extra stream: below this, one more channel's round trips gain nothing. */
const filesPerStream = 200;

/** The streams an archive of `files` files is spread over: 1 for a small one, at most 4. */
function streamsFor(files: number): number {
  return Math.max(1, Math.min(maxStreams, Math.ceil(files / filesPerStream)));
}

/**
 * The archive over `client`. Each send opens one exec channel running tarCommand(root) per
 * stream (streamsFor), all at once; each packs files taken in turn from the one list, so every
 * file travels once and a channel the server refuses leaves its share to the others. It settles
 * once every channel has closed: done when each `tar` exited 0. One stream's failure closes the
 * others and fails the whole send. A stall (no byte taken on any stream for `timeoutMs`) fails
 * with timeout at once; a dropped connection with connection-lost; Ctrl-C closes every channel
 * and fails as connect's does (`interrupted`).
 */
export function createArchive(client: Client, timeoutMs: number): ArchiveUpload {
  let gone = false;
  client.on('close', () => {
    gone = true;
  });
  return {
    send(root, files, { onSent, signal }) {
      const command = tarCommand(root);
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new TransportError('unreachable', 'interrupted'));
          return;
        }
        if (gone) {
          reject(connectionLost());
          return;
        }
        if (files.length === 0) {
          resolve();
          return;
        }
        let settled = false;
        const settle = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(stall);
          signal?.removeEventListener('abort', onAbort);
          if (error === undefined) resolve();
          else reject(error);
        };
        let stall: NodeJS.Timeout | undefined;
        const channels = new Set<ClientChannel>();
        const packers = new Set<Readable>();
        /** The first failure on our side: it wins over what the server says after it. */
        let ours: Error | undefined;
        /** The first failure the server reported: a channel refused, a `tar` that failed. */
        let theirs: Error | undefined;
        /** Closes every channel and drops every packer (they close their local files). */
        const halt = (): void => {
          for (const packer of packers) {
            packer.unpipe();
            packer.destroy();
          }
          for (const channel of channels) channel.close();
        };
        const stop = (error: Error): void => {
          ours ??= error;
          halt();
        };
        const watch = (): void => {
          clearTimeout(stall);
          stall = setTimeout(() => {
            const error = new TransportError('timeout', 'no-answer', { timeoutMs });
            stop(error);
            settle(error);
          }, timeoutMs);
        };
        function onAbort(): void {
          stop(new TransportError('unreachable', 'interrupted'));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        watch();

        const queue = takeTurns(files, onSent);
        let running = streamsFor(files.length);
        /** Whether a stream carried files: the send is done only if every file had one. */
        let carried = false;
        /** One stream has ended (its channel closed, or never opened): the last one settles. */
        const ended = (): void => {
          running -= 1;
          if (running > 0) return;
          if (ours !== undefined) settle(ours);
          else if (gone) settle(connectionLost());
          else if (theirs !== undefined) settle(theirs);
          else if (!carried || queue.left() > 0) {
            settle(new TransportError('protocol', 'answer', { operation: 'upload', path: root }));
          } else settle();
        };
        const failed = (error: Error): void => {
          if (ours === undefined && theirs === undefined) {
            theirs = error;
            halt();
          }
        };

        for (let stream = running; stream > 0; stream -= 1) {
          client.exec(command, (error, opened) => {
            if (error) {
              // A refused channel leaves its files to the others; none at all is the server's.
              if (gone) ours ??= connectionLost(error);
              else if (!carried && running === 1) {
                failed(
                  new TransportError('protocol', 'answer', {
                    operation: 'upload',
                    path: root,
                    cause: error,
                  }),
                );
              }
              ended();
              return;
            }
            channels.add(opened);
            // Stopped already, or nothing left to take: nothing is packed, no local file opened.
            const idle = ours !== undefined || theirs !== undefined || queue.left() === 0;
            let code: number | undefined;
            let stderr = '';
            opened.on('exit', (exit: number | null) => {
              code = exit ?? undefined;
            });
            opened.stderr.on('data', (chunk: Buffer) => {
              watch();
              if (stderr.length < maxStderr) stderr += chunk.toString('utf8').slice(0, maxStderr);
            });
            opened.on('data', () => watch());
            opened.on('error', () => {
              // 'close' follows.
            });
            let packed: Readable | undefined;
            opened.on('close', () => {
              channels.delete(opened);
              // However the channel ended, its packer goes too: it closes the local file it holds.
              if (packed !== undefined) {
                packed.destroy();
                packers.delete(packed);
              }
              if (!idle && code !== 0 && !gone) failed(tarFailed(root, stderr));
              ended();
            });
            if (idle) {
              opened.close();
              return;
            }
            carried = true;
            const stream = packTar(root, queue.take());
            packed = stream;
            packers.add(stream);
            stream.on('data', () => watch());
            stream.on('error', (packError) => stop(packError));
            stream.pipe(opened);
          });
        }
      });
    },
  };
}

/**
 * The files as tar entries for several packers taking turns: each `take()` is one packer's
 * iterable, which takes the next file not yet taken by any. All are dated now (the server's
 * `tar -m` dates them anew on its own clock, which spec #41 decision 26 compares). `onSent`
 * hears each file once its packer moved past it, counting every packer's files and bytes.
 */
function takeTurns(
  files: readonly ArchiveFile[],
  onSent: (sent: { readonly files: number; readonly bytes: number }) => void,
): { take(): Iterable<TarEntry>; left(): number } {
  const mtime = Math.floor(Date.now() / 1000);
  let next = 0;
  let sent = 0;
  let bytes = 0;
  return {
    *take() {
      for (let file = files[next]; file !== undefined; file = files[next]) {
        next += 1;
        yield {
          name: file.path,
          source: { file: file.file, size: file.size },
          mode: fileMode,
          mtime,
        };
        sent += 1;
        bytes += file.size;
        onSent({ files: sent, bytes });
      }
    },
    left: () => files.length - next,
  };
}

/**
 * `tar` exited otherwise than 0: its first stderr line is the server's words. A full disk or
 * quota is `quota`, a refused write `permission`, anything else `protocol`.
 */
function tarFailed(root: ServerPath, stderr: string): TransportError {
  const said = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  const code = /quota|no space left/i.test(stderr)
    ? 'quota'
    : /permission denied/i.test(stderr)
      ? 'permission'
      : 'protocol';
  return new TransportError(code, 'answer', {
    operation: 'upload',
    path: root,
    ...(said === undefined ? {} : { serverSaid: said }),
  });
}
