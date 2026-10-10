---
title: Exit codes
description: What each exit code of sealup means, and whether the server changed.
---

Every exit code also tells you whether the server changed.

| Code | Meaning | Server changed |
|---|---|---|
| 0 | Done, or nothing to do | maybe: that was the point |
| 1 | Stopped part-way | yes, partly |
| 2 | Usage or config problem | no |
| 3 | Login refused (never retried) | no |
| 4 | Server identity not confirmed | no |
| 5 | Server unreachable | no |
| 6 | Stopped by a safety net | no |
| 130 | Interrupted (Ctrl-C) | maybe: see the last line |

## Details

- **1:** some changes are on the server, others are not. Running the same command again finishes
  the job: sealup sends only what is missing. An error sealup did not expect is 1 too
  ([internal-error](/e/internal-error/)).
- **2:** a bad flag ([usage](/e/usage/)), an unknown or missing target
  ([unknown-target](/e/unknown-target/), [target-not-named](/e/target-not-named/)), an invalid
  `sealup.yml` ([config-invalid](/e/config-invalid/)), a missing variable
  ([variable-not-set](/e/variable-not-set/)), `sealup pull` in CI
  ([pull-in-ci](/e/pull-in-ci/)).
- **3:** the server refused the login ([login-refused](/e/login-refused/)). sealup never
  retries: hosts block an IP after failed logins.
- **4:** the host key is missing or changed ([host-key-missing](/e/host-key-missing/),
  [host-key-changed](/e/host-key-changed/)), or over FTPS, TLS was refused or its certificate
  is not trusted ([tls-refused](/e/tls-refused/), [certificate-refused](/e/certificate-refused/)).
- **5:** DNS, timeout, connection refused, or dropped before any change
  ([unreachable](/e/unreachable/), [timeout](/e/timeout/),
  [connection-lost](/e/connection-lost/)).
- **6:** an empty source ([empty-source](/e/empty-source/)), a mirror into the server's root or
  the login folder ([risky-folder](/e/risky-folder/)), a symlink ([symlink](/e/symlink/)), a
  secret file into a public folder ([secret-file-public](/e/secret-file-public/)), a file list
  on the server sealup cannot
  trust ([manifest-invalid](/e/manifest-invalid/)), or another run deploying to the same target
  ([lock-held](/e/lock-held/)).
- **130:** you pressed Ctrl-C, or did not answer a question
  ([interrupted](/e/interrupted/), [cancelled](/e/cancelled/)). The last line says what the
  server has.

## In a script

- 0: fine.
- 2 to 6: nothing changed; fix the cause first.
- 1: run the same command again.
- 130: read the last line, then run again.

`--json` prints one JSON object on stdout with the same facts: the status, what changed, and the
error with its fix lines.
