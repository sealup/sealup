// The permission bits of an FTP file, independently of a successful SITE CHMOD reply. An upload
// can reset those bits: R17 needs the mode the server actually kept, before sending a secret.

import type { Client } from 'basic-ftp';
import { parseListLine } from './ftp-list.ts';

/** The parent LIST avoids glob expansion of a file name; an unreadable listing proves no mode. */
export async function ftpFileMode(client: Client, path: string): Promise<number | undefined> {
  let mode: number | undefined;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const now = Math.floor(Date.now() / 1000);
  client.availableListCommands = ['LIST -a'];
  client.parseList = (text) => {
    for (const line of text.split(/\r?\n/)) {
      const entry = parseListLine(line, now);
      if (entry?.facts.kind === 'file' && entry.name === name) {
        mode = entry.facts.mode;
      }
    }
    return [];
  };
  try {
    await client.cd(path.slice(0, path.lastIndexOf('/')) || '/');
    await client.list();
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number') {
      return undefined;
    }
    throw error;
  }
  return mode;
}
