// One name a server lists, before `sealup pull` writes it on this machine (R10 with the Windows
// rules, R19; R21: at most 255 bytes). The rules apply on every system, so a pulled folder can
// move between machines, and a hostile server cannot name its way out of the local folder.

import type { UnsafeName } from '../contracts/index.ts';

const controlCharacter = /\p{Cc}/u;
const windowsCharacter = /[<>:"|?*]/;
const windowsReserved = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** `.<name>.sealup-<16 hex>.tmp`, as tempNameFor makes them. */
export const sealupTemp = /^\..+\.sealup-[0-9a-f]{16}\.tmp$/;
const maxNameBytes = 255;

/** Whether a server name may become a local name as it is; else why not. */
export function pullNameProblem(name: string): UnsafeName | undefined {
  if (name === '' || name === '.' || name === '..') return 'dot-name';
  if (name.includes('/')) return 'slash';
  if (name.includes('\\')) return 'backslash';
  if (controlCharacter.test(name)) return 'control-character';
  if (name.normalize('NFC') !== name) return 'not-nfc';
  if (windowsCharacter.test(name)) return 'windows-character';
  if (/[. ]$/.test(name)) return 'trailing-dot-space';
  if (windowsReserved.test(name)) return 'windows-reserved';
  if (new TextEncoder().encode(name).length > maxNameBytes) return 'too-long';
  if (sealupTemp.test(name)) return 'sealup-temp';
  return undefined;
}
