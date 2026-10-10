// Bites: useNodejsImportProtocol, a Node built-in without the node: prefix.
// Placed at: src/scan/use-nodejs-import-protocol.ts
// Expect: lint/style/useNodejsImportProtocol
import { readFileSync } from 'fs';

export const read = readFileSync;
