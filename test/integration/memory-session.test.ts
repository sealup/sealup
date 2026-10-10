// The memory Session passes the shared Session contract suite (decision 0013). The in-process
// SFTP server and later transports run the same suite through sessionContract().

import { describe, expect, it } from 'vitest';
import type { ServerPath, ServerUrl } from '../../src/contracts/index.ts';
import {
  archiveContract,
  createMemoryServer,
  hostKeyScanContract,
  sessionContract,
  sessionFaultContract,
} from '../../src/testkit/index.ts';

sessionContract('memory', async () => createMemoryServer());
sessionFaultContract('memory', async () => createMemoryServer());
// The memory server's archive (0034): files land as the server's `tar` would put them.
archiveContract('memory', async () => createMemoryServer({ archive: true }));
hostKeyScanContract('memory', async () => {
  const server = createMemoryServer();
  const url: ServerUrl = {
    protocol: 'sftp',
    user: 'deploy',
    host: 'example.com',
    port: 22,
    folder: '/',
  };
  return {
    ...server,
    scan: (options = {}) => server.scanHostKey(url, { signal: options.signal, timeoutMs: 30_000 }),
  };
});

describe('memory server, as a deploy test sees it', () => {
  it('shows the tree a session left, with sizes and SHA-256', async () => {
    const server = createMemoryServer({ loginFolder: '/home/site' });
    const session = await server.connect();
    await session.mkdir('/home/site/www' as ServerPath);
    await session.put(
      { bytes: new TextEncoder().encode('abc') },
      '/home/site/www/a.txt' as ServerPath,
    );
    await session.close();

    expect(server.folders()).toEqual(['/', '/home', '/home/site', '/home/site/www']);
    const files = server.files();
    expect([...files.keys()]).toEqual(['/home/site/www/a.txt']);
    // SHA-256 of "abc" (FIPS 180-2, appendix B.1).
    expect(files.get('/home/site/www/a.txt')).toMatchObject({
      size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });

  it('seeds files a person put there before, creating their folders', async () => {
    const server = createMemoryServer();
    server.seedFile('/home/deploy/www/uploads/user.jpg', 'kept');
    const session = await server.connect();
    const read = await session.read('/home/deploy/www/uploads/user.jpg' as ServerPath, 100);
    expect(read.kind === 'found' && new TextDecoder().decode(read.bytes)).toBe('kept');
    expect(server.folders()).toContain('/home/deploy/www/uploads');
  });

  it('refuses a path that is not an absolute ServerPath: a bug in the caller', async () => {
    const session = await createMemoryServer().connect();
    await expect(session.remove('www/../x' as ServerPath)).rejects.toThrow(RangeError);
  });
});
