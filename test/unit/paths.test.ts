// The one strict path rule (R10, decision 0019). Cases follow exploration 03's spike table
// (spikes/03-security/paths), plus the Windows inputs a scan on Windows produces.

import { describe, expect, it } from 'vitest';
import type { RemotePath, ServerPath } from '../../src/contracts/index.ts';
import {
  comparePaths,
  depth,
  excludeMatcher,
  foldersAbove,
  foldersToMake,
  inLoginFolder,
  isWithin,
  joinServer,
  localToRemote,
  parseRemotePath,
  parseServerPath,
  remoteToLocal,
  resolveServerFolder,
  tempNameFor,
  tempPathFor,
  under,
} from '../../src/paths/index.ts';

describe('parseRemotePath (R10)', () => {
  it.each([
    'index.php',
    'a/b.js',
    '__proto__',
    'constructor',
    '.deploy-manifest.json',
    '.htaccess',
    'a b/c d.txt',
    'café.txt',
    '..x',
    'x..',
  ])('accepts %j', (text) => {
    expect(parseRemotePath(text)).toEqual({ ok: true, path: text });
  });

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['//x', 'absolute'],
    ['..\\..\\Windows\\x.dll', 'backslash'],
    ['a\\..\\..\\x', 'backslash'],
    ['C:\\x', 'backslash'],
    ['\\\\srv\\share\\x', 'backslash'],
    ['C:x', 'drive-letter'],
    ['c:/x', 'drive-letter'],
    ['a/./b', 'dot-segment'],
    ['.', 'dot-segment'],
    ['../.ssh/authorized_keys', 'dot-dot-segment'],
    ['a/../../x', 'dot-dot-segment'],
    ['..', 'dot-dot-segment'],
    ['a//b', 'empty-segment'],
    ['a/', 'empty-segment'],
    ['x\u0000.php', 'control-character'],
    ['x\r\nDELE index.php', 'control-character'],
    ['tab\there', 'control-character'],
    ['del\u007f', 'control-character'],
    ['c1\u0085', 'control-character'],
    ['cafe\u0301.txt', 'not-nfc'],
  ])('refuses %j (%s)', (text, problem) => {
    expect(parseRemotePath(text)).toEqual({ ok: false, problem });
  });
});

describe('localToRemote: a path relative to a source folder, as the local OS wrote it', () => {
  it.each([
    ['win32', 'index.php', 'index.php'],
    ['win32', 'assets\\app.js', 'assets/app.js'],
    ['win32', 'My Site\\img\\a b.png', 'My Site/img/a b.png'],
    ['win32', 'assets/mixed\\app.js', 'assets/mixed/app.js'],
    ['posix', 'assets/app.js', 'assets/app.js'],
    ['posix', 'cafe\u0301.txt', 'café.txt'],
    ['win32', 'cafe\u0301.txt', 'café.txt'],
  ] as const)('%s %j becomes %j', (platform, local, remote) => {
    expect(localToRemote(local, platform)).toEqual({ ok: true, path: remote });
  });

  it.each([
    ['win32', '', 'empty'],
    ['win32', '..\\outside.txt', 'dot-dot-segment'],
    ['win32', 'a\\..\\..\\x', 'dot-dot-segment'],
    ['win32', 'C:\\Windows\\x.dll', 'drive-letter'],
    ['win32', 'C:x', 'drive-letter'],
    ['win32', '\\x', 'absolute'],
    ['win32', '\\\\srv\\share\\x', 'absolute'],
    ['win32', 'a\\\\b', 'empty-segment'],
    ['win32', 'a\\', 'empty-segment'],
    ['win32', '.\\a', 'dot-segment'],
    ['posix', 'a\\b', 'backslash'],
    ['posix', '/etc/passwd', 'absolute'],
    ['posix', '../x', 'dot-dot-segment'],
    ['posix', 'x\nDELE y', 'control-character'],
  ] as const)('%s %j is refused (%s)', (platform, local, problem) => {
    expect(localToRemote(local, platform)).toEqual({ ok: false, problem });
  });
});

describe('remoteToLocal', () => {
  it('uses the separator of the local OS', () => {
    const path = remote('My Site/img/a b.png');
    expect(remoteToLocal(path, 'win32')).toBe('My Site\\img\\a b.png');
    expect(remoteToLocal(path, 'posix')).toBe('My Site/img/a b.png');
  });

  it('round-trips with localToRemote', () => {
    const path = remote('a/b c/__proto__/d.txt');
    for (const platform of ['win32', 'posix'] as const) {
      expect(localToRemote(remoteToLocal(path, platform), platform)).toEqual({ ok: true, path });
    }
  });
});

describe('parseServerPath: absolute POSIX paths on the server (ruling 7)', () => {
  it.each(['/', '/home/deploy', '/home/deploy/www/__proto__', '/srv/a b/.sealup'])(
    'accepts %j',
    (text) => {
      expect(parseServerPath(text)).toEqual({ ok: true, path: text });
    },
  );

  it.each([
    ['', 'empty'],
    ['home/deploy', 'relative'],
    ['~/www', 'relative'],
    ['/home/', 'empty-segment'],
    ['//home', 'empty-segment'],
    ['/home/./www', 'dot-segment'],
    ['/home/../etc', 'dot-dot-segment'],
    ['/home\\deploy', 'backslash'],
    ['/home/x\ny', 'control-character'],
    ['/café', 'not-nfc'],
  ])('refuses %j (%s)', (text, problem) => {
    expect(parseServerPath(text)).toEqual({ ok: false, problem });
  });
});

describe('resolveServerFolder: the folder of a server URL, against the login folder', () => {
  const login = server('/home/deploy');

  it.each([
    ['/var/www/site', '/var/www/site'],
    ['/~', '/home/deploy'],
    ['/~/', '/home/deploy'],
    ['/~/staging/site', '/home/deploy/staging/site'],
    ['/~user/www', '/~user/www'],
  ])('%j resolves to %j', (folder, expected) => {
    expect(resolveServerFolder(folder, login)).toEqual({ ok: true, path: expected });
  });

  it('resolves against the root login folder', () => {
    expect(resolveServerFolder('/~/www', server('/'))).toEqual({ ok: true, path: '/www' });
  });

  it.each([
    ['/~/../etc', 'dot-dot-segment'],
    ['/~//www', 'empty-segment'],
    ['www', 'relative'],
  ])('refuses %j (%s)', (folder, problem) => {
    expect(resolveServerFolder(folder, login)).toEqual({ ok: false, problem });
  });
});

describe('joinServer: a RemotePath inside a server folder (R10)', () => {
  it('joins inside the folder', () => {
    expect(joinServer(server('/home/deploy/www'), remote('assets/app.js'))).toBe(
      '/home/deploy/www/assets/app.js',
    );
    expect(joinServer(server('/'), remote('www/index.php'))).toBe('/www/index.php');
  });

  it.each(['../etc/passwd', 'a/../../x', '/etc/passwd', 'a//b', ''])(
    'refuses a forged RemotePath %j instead of escaping the folder',
    (forged) => {
      expect(() => joinServer(server('/home/deploy/www'), forged as RemotePath)).toThrow(
        RangeError,
      );
    },
  );
});

describe('foldersToMake: the folders to create so that a server folder exists', () => {
  it('lists each folder below the login folder, outermost first', () => {
    expect(foldersToMake(server('/home/deploy'), server('/home/deploy/a/b c/d'))).toEqual([
      '/home/deploy/a',
      '/home/deploy/a/b c',
      '/home/deploy/a/b c/d',
    ]);
    expect(foldersToMake(server('/'), server('/www/site'))).toEqual(['/www', '/www/site']);
  });

  it('only the folder itself when it is outside the login folder: sealup makes no parents there', () => {
    expect(foldersToMake(server('/home/deploy'), server('/home/site/www'))).toEqual([
      '/home/site/www',
    ]);
    expect(foldersToMake(server('/home/deploy'), server('/home/deployed'))).toEqual([
      '/home/deployed',
    ]);
  });

  it('nothing for the login folder itself', () => {
    expect(foldersToMake(server('/home/deploy'), server('/home/deploy'))).toEqual([]);
  });
});

describe('under: paths in the form the config writes them', () => {
  it.each([
    ['', 'a/b.js', 'a/b.js'],
    ['dist', 'a/b.js', 'dist/a/b.js'],
    ['../site', 'x', '../site/x'],
    ['/~/www', '', '/~/www'],
    ['/~/www/', 'assets', '/~/www/assets'],
    ['/home/site', 'assets', '/home/site/assets'],
  ])('%j and %j give %j', (folder, rest, joined) => {
    expect(under(folder, rest)).toBe(joined);
  });
});

describe('inLoginFolder: a server folder in the `/~/` form', () => {
  it.each([
    ['/~', true],
    ['/~/www', true],
    ['/~user/www', false],
    ['/home/site', false],
  ])('%j: %s', (folder, inside) => {
    expect(inLoginFolder(folder)).toBe(inside);
  });
});

describe('comparePaths: one order of paths on every machine', () => {
  it('orders by code unit, not by locale', () => {
    const paths = ['b.txt', 'a/b.txt', 'B.txt', 'a b.txt', 'é.txt', 'a.txt', 'a.txt'];
    expect([...paths].sort(comparePaths)).toEqual([
      'B.txt',
      'a b.txt',
      'a.txt',
      'a.txt',
      'a/b.txt',
      'b.txt',
      'é.txt',
    ]);
  });
});

describe('foldersAbove: the folders a remote path sits in', () => {
  it('lists them outermost first, the path itself left out', () => {
    expect(foldersAbove('a/b/c.txt' as RemotePath)).toEqual(['a', 'a/b']);
    expect(foldersAbove('index.html' as RemotePath)).toEqual([]);
  });

  it('refuses a forged path', () => {
    expect(() => foldersAbove('a/../b' as RemotePath)).toThrow(RangeError);
  });
});

describe('depth: how many segments a remote path has', () => {
  it('counts a top-level name as 1, each folder above it as one more', () => {
    expect(depth('index.html' as RemotePath)).toBe(1);
    expect(depth('a' as RemotePath)).toBe(1);
    expect(depth('a/b/c.txt' as RemotePath)).toBe(3);
  });
});

describe('tempNameFor: where an upload waits before its rename (R18)', () => {
  const random = '0123456789abcdef';

  it('is a hidden name in the same folder', () => {
    expect(tempNameFor('/home/site/a b/index.html' as ServerPath, random)).toBe(
      '/home/site/a b/.index.html.sealup-0123456789abcdef.tmp',
    );
    expect(tempNameFor('/index.html' as ServerPath, random)).toBe(
      '/.index.html.sealup-0123456789abcdef.tmp',
    );
  });

  it('refuses a random part that is not 16 lowercase hex characters, or a forged path', () => {
    expect(() => tempNameFor('/home/a' as ServerPath, '../x')).toThrow(RangeError);
    expect(() => tempNameFor('/' as ServerPath, random)).toThrow(RangeError);
    expect(() => tempNameFor('/home/../a' as ServerPath, random)).toThrow(RangeError);
  });
});

describe('tempPathFor: the same temp name, relative to the target folder (decision 0032)', () => {
  const random = '0123456789abcdef';

  it('is the hidden name in the same folder', () => {
    expect(tempPathFor('a b/index.html' as RemotePath, random)).toBe(
      'a b/.index.html.sealup-0123456789abcdef.tmp',
    );
    expect(tempPathFor('index.html' as RemotePath, random)).toBe(
      '.index.html.sealup-0123456789abcdef.tmp',
    );
  });

  it('refuses a random part that is not 16 lowercase hex characters, or a forged path', () => {
    expect(() => tempPathFor('a' as RemotePath, '../x')).toThrow(RangeError);
    expect(() => tempPathFor('../a' as RemotePath, random)).toThrow(RangeError);
  });
});

describe('isWithin: whether a folder is another or inside it (R14)', () => {
  it.each([
    ['/home/site/.sealup', '/home/site', true],
    ['/home/site', '/home/site', true],
    ['/home/site/', '/home/site', true],
    ['/anything', '/', true],
    ['/~/www/.sealup', '/~/www', true],
    ['/~/.sealup', '/~', true],
    ['/~/.sealup', '/~/', true],
    ['/home/site2/.sealup', '/home/site', false],
    ['/home', '/home/site', false],
    ['/~/.sealup', '/~/www', false],
  ])('%s in %s: %s', (folder, root, expected) => {
    expect(isWithin(folder, root)).toBe(expected);
  });
});

describe('excludeMatcher: .gitignore patterns, on paths relative to the config folder', () => {
  // Expected values from the gitignore documentation (git-scm.com/docs/gitignore, "PATTERN
  // FORMAT"), on the page's own excludes (reference.js `full`: public_html/resources, api/.env*).
  it.each([
    // A slash at the start or in the middle anchors the pattern to the config folder.
    [['public_html/resources'], 'public_html/resources/cat.jpg', true],
    [['public_html/resources'], 'public_html/resources/2024/a b.jpg', true],
    [['public_html/resources'], 'public_html/resources.txt', false],
    [['public_html/resources'], 'x/public_html/resources/cat.jpg', false],
    [['/public_html/resources'], 'public_html/resources/cat.jpg', true],
    [['api/.env*'], 'api/.env', true],
    [['api/.env*'], 'api/.env.prod', true],
    [['api/.env*'], 'api/config/.env', false],
    [['api/storage'], 'api/storage/logs/laravel.log', true],
    // No slash (or only a trailing one): matches a name at any depth.
    [['*.map'], 'public_html/main.js.map', true],
    [['*.map'], 'main.js.map', true],
    [['*.map'], 'public_html/main.js', false],
    [['.DS_Store'], 'public_html/img/.DS_Store', true],
    [['cache'], 'public_html/cache/a.html', true],
    // A trailing slash matches folders only.
    [['cache/'], 'public_html/cache/a.html', true],
    [['cache/'], 'public_html/cache', false],
    // `*` and `?` stop at a slash; `[…]` is a class, `[!…]` its complement.
    [['public_html/*.html'], 'public_html/index.html', true],
    [['public_html/*.html'], 'public_html/admin/index.html', false],
    [['public_html/?.js'], 'public_html/a.js', true],
    [['public_html/?.js'], 'public_html/ab.js', false],
    [['public_html/[ab].js'], 'public_html/b.js', true],
    [['public_html/[!ab].js'], 'public_html/b.js', false],
    [['public_html/[!ab].js'], 'public_html/c.js', true],
    // `**`: leading (any depth), trailing (everything inside), middle (zero or more folders).
    [['**/logs'], 'api/storage/logs/x.log', true],
    [['**/logs'], 'logs/x.log', true],
    [['public_html/**'], 'public_html/a/b.js', true],
    [['public_html/**'], 'api/a.js', false],
    [['api/**/x.php'], 'api/x.php', true],
    [['api/**/x.php'], 'api/a/b/x.php', true],
    // `!` re-includes, the last matching pattern wins...
    [['*.log', '!keep.log'], 'api/keep.log', false],
    [['!keep.log', '*.log'], 'api/keep.log', true],
    // ...but not a file whose folder is excluded (git cannot re-include it either).
    [['api/storage', '!api/storage/keep.txt'], 'api/storage/keep.txt', true],
    // A backslash escapes; a leading `\!` or `\#` is a plain character.
    [['\\!important.txt'], '!important.txt', true],
    [['a\\*b'], 'a*b', true],
    [['a\\*b'], 'axb', false],
    // Regex characters are plain.
    [['a+b.(1)'], 'a+b.(1)', true],
    [['a+b.(1)'], 'aab.(1)', false],
    // No pattern, or a blank or comment one: nothing is excluded.
    [[], 'a.js', false],
    [['', '   ', '# a.js'], 'a.js', false],
    // A source folder outside the config folder: anchored patterns cannot reach it.
    [['*.map'], '../dist/a.js.map', true],
    [['dist'], '../dist/a.js', true],
  ] as const)('%j on %j: %j', (patterns, path, excluded) => {
    expect(excludeMatcher(patterns)(path)).toBe(excluded);
  });
});

describe('property: whatever the input, an accepted path stays inside the folder (R10)', () => {
  // Seeded, so a failure reproduces; the alphabet is the characters that break naive rules.
  const alphabet = [
    'a',
    'Z',
    '.',
    '..',
    '/',
    '\\',
    ':',
    'C:',
    '~',
    ' ',
    '\u0000',
    '\n',
    '%2e',
    'é',
  ];
  const random = mulberry32(0x5ea1);
  const root = server('/home/deploy/www');
  const inputs = Array.from({ length: 5000 }, () =>
    Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
      return alphabet[Math.floor(random() * alphabet.length)] ?? '';
    }).join(''),
  );

  it('never yields a path with an escaping or empty segment', () => {
    let accepted = 0;
    for (const input of inputs) {
      for (const result of [parseRemotePath(input), localToRemote(input, 'win32')]) {
        if (!result.ok) continue;
        accepted++;
        const joined = joinServer(root, result.path);
        expect(joined.startsWith(`${root}/`)).toBe(true);
        expect(joined.split('/').slice(1)).not.toContainEqual(expect.stringMatching(/^\.{0,2}$/));
        expect(joined).not.toMatch(/[\\\p{Cc}]/u);
      }
    }
    expect(accepted).toBeGreaterThan(100);
  });
});

/** A small seeded PRNG (mulberry32), returns numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function server(text: string): ServerPath {
  const result = parseServerPath(text);
  if (!result.ok) throw new Error(`test setup: ${text} is not a ServerPath (${result.problem})`);
  return result.path;
}

function remote(text: string): RemotePath {
  const result = parseRemotePath(text);
  if (!result.ok) throw new Error(`test setup: ${text} is not a RemotePath (${result.problem})`);
  return result.path;
}
