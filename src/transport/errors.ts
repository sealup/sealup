// The Session's own errors that the SFTP and FTP sessions raise alike (the contract suite holds
// both to them): a path held by the other kind, and a file that changed while it was read.

import { type ServerPath, TransportError } from '../contracts/index.ts';

/** A path held by the other kind: a file where a folder is made, or a folder where a file goes. */
export function inTheWay(found: 'file' | 'folder', path: ServerPath): TransportError {
  return new TransportError('protocol', 'in-the-way', { path, inTheWay: found });
}

/** A file longer or shorter than the size the caller gave: it changed since it was listed. */
export function changed(path: ServerPath): TransportError {
  return new TransportError('protocol', 'changed', { path, operation: 'download' });
}
