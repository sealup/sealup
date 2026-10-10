// Bites: useImportType, a value import used only as a type.
// Placed at: src/scan/use-import-type.ts
// Expect: lint/style/useImportType
import { Stats } from 'node:fs';

export function size(stats: Stats): number {
  return stats.size;
}
