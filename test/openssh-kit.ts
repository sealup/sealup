// A real OpenSSH server in a Docker container, for the end-to-end tests (ticket 11): built from
// test/e2e/openssh/Dockerfile, published on a free port of 127.0.0.1, with user `deploy`, the
// password the test gives, and the public key it gives in `authorized_keys`. What the server holds is read inside the container (`docker exec`:
// sizes with `stat`, SHA-256 with `sha256sum`), never through sealup's own transport, so a bug
// in the transport cannot hide itself.
//
// Child processes live here, in test/, because src/ may not start any (R5).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as dial } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../scripts/gates.ts';
import { readTree } from '../src/testkit/index.ts';

const image = 'sealup-e2e-openssh';
const home = '/home/deploy';

/** Whether a Docker daemon answers and runs Linux containers (Windows CI runs Windows ones). */
export function dockerRunsLinux(): boolean {
  const info = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return info.status === 0 && info.stdout.trim() === 'linux';
}

export interface FileFacts {
  readonly size: number;
  /** Lowercase hex. */
  readonly sha256: string;
}

/** What a container's login folder holds, read inside the container (FTP servers share it). */
export interface ContainerFiles {
  /** Every file under `folder` (relative to the login folder), by `/` path relative to it. */
  tree(folder: string): Promise<Map<string, FileFacts>>;
  /** Every folder under `folder`, by `/` path relative to it, sorted. */
  folders(folder: string): Promise<string[]>;
  /** The bytes of every file under `folder`, for the leak test. */
  files(folder: string): Promise<Record<string, Uint8Array>>;
  /**
   * A file's permission bits and inode, read with `stat` inside the container (`path` relative
   * to the login folder): a new inode means the file was put again.
   */
  stat(path: string): Promise<{ readonly mode: number; readonly inode: number }>;
  /** Puts a symbolic link at the absolute `path`, pointing at `target` (contract set-up). */
  seedLink(path: string, target: string): Promise<void>;
  /** Empties the login folder (the contract suite wants an empty one per test). */
  clear(): Promise<void>;
}

export interface OpenSshServer extends ContainerFiles {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** A second user, same password, whose every command runs sftp-server (ForceCommand). */
  readonly sftpOnlyUser: string;
  readonly password: string;
  /** Its ed25519 host key, `ssh-ed25519 <base64>`, read inside the container (no keyscan). */
  readonly hostKeyLine: string;
  /** The key's OpenSSH fingerprint, `SHA256:…`. */
  readonly fingerprint: string;
  stop(): Promise<void>;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `docker <args>`, with `input` on its stdin; fails on a non-zero exit. */
export function docker(args: readonly string[], input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`docker ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

/**
 * Builds the image (cached by Docker), starts a container, sets the password and the authorized
 * key (an `authorized_keys` line, decision 0033), waits for sshd.
 */
export async function startOpenSsh(options: {
  readonly password: string;
  readonly authorizedKey?: string;
}): Promise<OpenSshServer> {
  await docker(['build', '--quiet', '--tag', image, join(repoRoot, 'test', 'e2e', 'openssh')]);
  const id = (
    await docker(['run', '--detach', '--rm', '--publish', '127.0.0.1::22', image])
  ).stdout.trim();
  try {
    // The password goes on chpasswd's stdin, never in an argument list.
    await docker(
      ['exec', '--interactive', id, 'chpasswd'],
      `deploy:${options.password}\nsftponly:${options.password}\n`,
    );
    if (options.authorizedKey !== undefined) {
      // Owned by root, readable by all, as sshd's StrictModes wants; on stdin, as the password.
      const file = '/etc/ssh/authorized_keys/deploy';
      await docker(
        ['exec', '--interactive', id, 'sh', '-c', 'cat > "$1" && chmod 644 "$1"', 'sh', file],
        `${options.authorizedKey}\n`,
      );
    }
    const published = (await docker(['port', id, '22/tcp'])).stdout.trim().split('\n')[0] ?? '';
    const port = Number(published.slice(published.lastIndexOf(':') + 1));
    await waitForBanner('127.0.0.1', port);
    const line = (await docker(['exec', id, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])).stdout;
    const [type = '', key = ''] = line.trim().split(' ');
    const fingerprint = `SHA256:${createHash('sha256')
      .update(Buffer.from(key, 'base64'))
      .digest('base64')
      .replace(/=+$/, '')}`;
    return {
      host: '127.0.0.1',
      port,
      user: 'deploy',
      sftpOnlyUser: 'sftponly',
      password: options.password,
      hostKeyLine: `${type} ${key}`,
      fingerprint,
      ...containerFiles(id, home, (path) => path),
      async stop() {
        await docker(['rm', '--force', id]);
      },
    };
  } catch (error) {
    await docker(['rm', '--force', id]).catch(() => undefined);
    throw error;
  }
}

/**
 * The login folder `home` of container `id`, read and set up inside it. `linkPath` turns the path
 * a session names into the container's (a chrooted FTP user's `/x` is `<home>/x`).
 */
export function containerFiles(
  id: string,
  home: string,
  linkPath: (path: string) => string,
): ContainerFiles {
  const inside = (folder: string) => `${home}/${folder}`;
  const shell = async (script: string, ...args: string[]) =>
    (await docker(['exec', id, 'sh', '-c', script, 'sh', ...args])).stdout;
  return {
    async tree(folder) {
      // One line per file: size, SHA-256, path (`./` first); paths may hold spaces.
      const out = await shell(
        'cd "$1" && find . -type f -exec sh -c \'for f; do printf "%s %s %s\\n" "$(stat -c %s "$f")" "$(sha256sum < "$f" | cut -c1-64)" "$f"; done\' sh {} +',
        inside(folder),
      );
      const tree = new Map<string, FileFacts>();
      for (const row of out.split('\n').filter((r) => r !== '')) {
        const [size = '', sha256 = ''] = row.split(' ', 2);
        const path = row.slice(size.length + sha256.length + 2).replace(/^\.\//, '');
        tree.set(path, { size: Number(size), sha256 });
      }
      return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : 1)));
    },
    async folders(folder) {
      const out = await shell('cd "$1" && find . -mindepth 1 -type d', inside(folder));
      return out
        .split('\n')
        .filter((r) => r !== '')
        .map((r) => r.replace(/^\.\//, ''))
        .sort();
    },
    async files(folder) {
      const local = mkdtempSync(join(tmpdir(), 'sealup-e2e-server-'));
      try {
        await docker(['cp', `${id}:${inside(folder)}/.`, local]);
        return await readTree(local);
      } finally {
        rmSync(local, { recursive: true, force: true });
      }
    },
    async stat(path) {
      const [mode = '', inode = ''] = (await shell('stat -c "%a %i" "$1"', inside(path)))
        .trim()
        .split(' ');
      return { mode: Number.parseInt(mode, 8), inode: Number(inode) };
    },
    async seedLink(path, target) {
      // As the user, so the link belongs to `deploy` like the files around it.
      await docker(['exec', '--user', 'deploy', id, 'ln', '-s', '--', target, linkPath(path)]);
    },
    async clear() {
      await shell('cd "$1" && rm -rf -- * .[!.]* ..?*', home);
    },
  };
}

/** Waits until sshd sends its `SSH-2.0-` banner (Docker's port proxy accepts before sshd does). */
async function waitForBanner(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = dial({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(2_000, () => done(false));
      socket.once('data', (data) => done(data.toString('latin1').startsWith('SSH-')));
      socket.once('error', () => done(false));
      socket.once('close', () => done(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`sshd on ${host}:${port} did not answer within 30 s`);
}
