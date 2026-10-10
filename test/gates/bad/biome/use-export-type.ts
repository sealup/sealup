// Bites: useExportType, a type re-exported without `export type`.
// Placed at: src/scan/use-export-type.ts
// Expect: lint/style/useExportType
import type { Stats } from 'node:fs';

export { Stats };
