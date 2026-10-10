// How the in-process FTP server describes its entries: MLSD and MLST facts (RFC 3659, as ProFTPD
// and Pure-FTPd write them) and `ls -l` lines for LIST (as vsftpd writes them, dates in UTC).

import type { Entry } from './tree.ts';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** About six months: older dates show their year instead of their time, as `ls -l` does. */
const recentSeconds = 182 * 24 * 3600;

const two = (n: number): string => String(n).padStart(2, '0');

function sizeOf(entry: Entry): number {
  if (entry.kind === 'file') return entry.bytes.length;
  if (entry.kind === 'link') return entry.target.length;
  return entry.kind === 'folder' ? 4096 : 0;
}

/** `YYYYMMDDHHMMSS`, UTC (RFC 3659 §2.3). */
export function mlsxTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  return (
    `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}` +
    `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`
  );
}

const mlsxTypes: Readonly<Record<Entry['kind'], string>> = {
  file: 'file',
  folder: 'dir',
  link: 'OS.unix=symlink',
  other: 'OS.unix=socket',
};

/** One MLSD (or MLST) line: the facts, a space, then the name. */
export function mlsxLine(entry: Entry, name: string, type = mlsxTypes[entry.kind]): string {
  const mode = entry.mode.toString(8).padStart(4, '0');
  const facts = [
    `type=${type}`,
    `size=${sizeOf(entry)}`,
    `modify=${mlsxTime(entry.mtime)}`,
    `UNIX.mode=${mode}`,
    'UNIX.owner=deploy',
  ];
  return `${facts.join(';')}; ${name}`;
}

/** The nine permission letters of `ls -l`, with setuid, setgid and sticky. */
function permissions(mode: number): string {
  const triplet = (bits: number, special: boolean, letter: string): string => {
    const x = (bits & 1) !== 0;
    const exec = special ? (x ? letter : letter.toUpperCase()) : x ? 'x' : '-';
    return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${exec}`;
  };
  return (
    triplet((mode >> 6) & 7, (mode & 0o4000) !== 0, 's') +
    triplet((mode >> 3) & 7, (mode & 0o2000) !== 0, 's') +
    triplet(mode & 7, (mode & 0o1000) !== 0, 't')
  );
}

const typeLetters: Readonly<Record<Entry['kind'], string>> = {
  file: '-',
  folder: 'd',
  link: 'l',
  other: 's',
};

/** One `ls -l` line, its date in UTC as vsftpd gives it, `now` in seconds since 1970. */
export function listLine(entry: Entry, name: string, now: number): string {
  const d = new Date(entry.mtime * 1000);
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const when =
    Math.abs(now - entry.mtime) < recentSeconds
      ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
      : ` ${d.getUTCFullYear()}`;
  const shown = entry.kind === 'link' ? `${name} -> ${entry.target}` : name;
  const size = String(sizeOf(entry)).padStart(8, ' ');
  return `${typeLetters[entry.kind]}${permissions(entry.mode)}    1 deploy   deploy   ${size} ${months[d.getUTCMonth()]} ${day} ${when} ${shown}`;
}
