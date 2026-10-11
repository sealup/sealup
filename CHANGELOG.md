# Changelog

## [0.1.1](https://github.com/sealup/sealup/compare/v0.1.0...v0.1.1) (2026-10-11)

### Bug Fixes

* **cli:** the installed `sealup` command runs with Node: 0.1.0's `npx sealup` did nothing on Windows and failed on Linux and macOS (its first line, `#!/usr/bin/env node`, was missing). The GitHub Action was not affected.
* **ftp:** a short `timeout` no longer fails the connection right after login ("no login folder" on a slow link).

## 0.1.0 (2026-10-10)

The first public release.

### Features

* `sealup deploy` sends only what changed to a target over `sftp://`, `ssh://` (SFTP, plus one `tar` stream for the uploads when the server has `tar`), `ftps://` or `ftp://`, logging in with a password or a private key.
* Each file arrives under a temporary name and is renamed into place; a list on the server of what sealup uploaded means it deletes only its own files. `--mirror` also deletes the server files it did not upload, minus excludes.
* A lock on the server keeps two deploys from running into one target at once.
* No confirmation step: `--dry-run` shows every change first, and sealup stops before an empty build folder, a risky target folder, a symlink or a secret file in a public folder.
* Secrets come from environment variables (`sealup.env` on your machine, secrets in CI), are never printed, and are refused when written in `sealup.yml`; `write:` builds a server file from a secret, never on disk.
* `sealup init` writes `sealup.yml`, `sealup.env` and a GitHub workflow; `sealup keyscan` pins the host key; `sealup check` checks the config offline; `sealup pull` copies server folders (uploads) back.
* `--json` prints one JSON object, and the exit code says whether the server changed.
* The GitHub Action `sealup/sealup` runs the same code as the CLI.
