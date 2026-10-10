// FTP listings as ServerEntry facts (spec #41 decision 6): MLSD and MLST facts (RFC 3659) when
// the server offers them, else `ls -l` lines from LIST. basic-ftp's own parsers drop the mode's
// setuid, setgid and sticky bits and give LIST dates as raw text, so these are ours. Pure: no
// node: import. A line that matches neither form is left out, never guessed at.

import type { ServerEntry } from '../contracts/index.ts';

/** What one look at a path finds: an entry's facts without its name. */
export type Facts = Omit<ServerEntry, 'name'>;

/** One MLSD or MLST line (`fact=value;…; name`), or undefined for `.`, `..` and junk. */
export function parseMlsxLine(line: string): { name: string; facts: Facts } | undefined {
  const space = line.indexOf(' ');
  if (space === -1) return undefined;
  const name = line.slice(space + 1);
  const facts = new Map<string, string>();
  for (const fact of line.slice(0, space).split(';')) {
    const equals = fact.indexOf('=');
    if (equals > 0) facts.set(fact.slice(0, equals).toLowerCase(), fact.slice(equals + 1));
  }
  const type = (facts.get('type') ?? '').toLowerCase();
  if (type === 'cdir' || type === 'pdir' || name === '' || name === '.' || name === '..') {
    return undefined;
  }
  const kind: ServerEntry['kind'] =
    type === 'file'
      ? 'file'
      : type === 'dir'
        ? 'folder'
        : type === 'os.unix=symlink' || type.startsWith('os.unix=slink')
          ? 'link'
          : 'other';
  const size = Number.parseInt(facts.get('size') ?? facts.get('sizd') ?? '0', 10);
  const mode = Number.parseInt(facts.get('unix.mode') ?? '0', 8);
  return {
    name,
    facts: {
      kind,
      size: Number.isSafeInteger(size) ? size : 0,
      mtime: mlsxSeconds(facts.get('modify') ?? ''),
      mode: Number.isNaN(mode) ? 0 : mode & 0o7777,
    },
  };
}

/** `YYYYMMDDHHMMSS[.sss]`, UTC (RFC 3659 §2.3), as whole seconds since 1970; 0 when unreadable. */
function mlsxSeconds(text: string): number {
  const parts = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(text);
  if (parts === null) return 0;
  const [, y, mo, d, h, mi, s] = parts.map(Number) as [number, ...number[]];
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi, s) / 1000;
}

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * One `ls -l` line: type, permissions, links, owner (and group), size, date, name. A date with a
 * time and no year is within the last six months: this year, or last year if that would be in the
 * future. LIST gives minutes at best, read as UTC (vsftpd's default): `list` reports what it has.
 */
const unixLine =
  /^([-dlpscbD])([-rwxsStT]{9})\S*\s+\d+\s+(?:\S+\s+){1,2}(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s(.*)$/;

/** One LIST line, or undefined for `total`, `.`, `..` and lines in another form. */
export function parseListLine(
  line: string,
  nowSeconds: number,
): { name: string; facts: Facts } | undefined {
  const parts = unixLine.exec(line);
  if (parts === null) return undefined;
  const [, type = '', perms = '', size = '', month = '', day = '', when = '', shown = ''] = parts;
  const kind: ServerEntry['kind'] =
    type === '-' ? 'file' : type === 'd' ? 'folder' : type === 'l' ? 'link' : 'other';
  const name = kind === 'link' && shown.includes(' -> ') ? (shown.split(' -> ')[0] ?? '') : shown;
  if (name === '' || name === '.' || name === '..') return undefined;
  const monthIndex = months.indexOf(month.toLowerCase());
  if (monthIndex === -1) return undefined;
  let mtime: number;
  if (when.includes(':')) {
    const [hours, minutes] = when.split(':').map(Number) as [number, number];
    const year = new Date(nowSeconds * 1000).getUTCFullYear();
    mtime = Date.UTC(year, monthIndex, Number(day), hours, minutes) / 1000;
    if (mtime > nowSeconds + 24 * 3600) {
      mtime = Date.UTC(year - 1, monthIndex, Number(day), hours, minutes) / 1000;
    }
  } else {
    mtime = Date.UTC(Number(when), monthIndex, Number(day)) / 1000;
  }
  return { name, facts: { kind, size: Number(size), mtime, mode: modeOf(perms) } };
}

/** The nine letters of `ls -l` as permission bits, with setuid, setgid and sticky. */
function modeOf(perms: string): number {
  let mode = 0;
  for (let i = 0; i < 9; i++) {
    const letter = perms[i] ?? '-';
    const bit = 1 << (8 - i);
    if (letter === 'r' || letter === 'w' || letter === 'x' || letter === 's' || letter === 't') {
      mode |= bit;
    }
  }
  const special = (at: number, lower: string, flag: number): number =>
    perms[at]?.toLowerCase() === lower ? flag : 0;
  return mode | special(2, 's', 0o4000) | special(5, 's', 0o2000) | special(8, 't', 0o1000);
}
