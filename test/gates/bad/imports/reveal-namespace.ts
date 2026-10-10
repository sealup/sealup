// Bites: a namespace import of secret would hand reveal() to a module other than transport.
// Placed at: src/config/secret-namespace.ts
// Expect: reveal-only-transport
import * as secret from '../secret/index.ts';

export const used = secret;
