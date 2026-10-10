// Bites: noReExportAll; an entry file lists its exports one by one (decision 0009).
// Placed at: src/plan/no-re-export-all.ts
// Expect: lint/performance/noReExportAll
export * from './other.ts';
