// Test projects (decision 0010):
//   unit         pure and I/O tests of one module, through its entry file; runs after each edit
//   integration  in-process servers, contract suites, and the gates' proven-to-bite tests
//   e2e          a deploy, then a verify of the server (containers on Linux CI)
//   e2e-ftp      the same against the FTP servers' containers (Pure-FTPd, ProFTPD, vsftpd)
// The pre-commit hook and `npm run check` run unit and integration; CI runs them all.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          // test/private/: tests of files the public export leaves out; private, like them.
          include: [
            'test/integration/**/*.test.ts',
            'test/gates/**/*.test.ts',
            'test/private/**/*.test.ts',
          ],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          exclude: ['test/e2e/ftp-*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        // The FTP servers' containers (spec #41 decision 17): their own CI job, beside e2e's.
        test: {
          name: 'e2e-ftp',
          include: ['test/e2e/ftp-*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
