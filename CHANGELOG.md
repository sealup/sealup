# Changelog

## [0.2.1](https://github.com/sealup/sealup/compare/v0.2.0...v0.2.1) (2026-10-13)

No change to how sealup works: maintenance only.

## [0.2.0](https://github.com/sealup/sealup/compare/v0.1.1...v0.2.0) (2026-10-12)

### Breaking changes

* **cli:** `-n` is gone: the dry run is `--dry-run` only, for `deploy` and `pull`. `-n` is now an unknown flag (exit 2), so nothing deploys by mistake. Change `-n` to `--dry-run` in your scripts. The Action's `dry-run` input is unchanged.
* **init:** the workflow `sealup init` writes uses the Action by its version, `uses: sealup/sealup@v0.2.0`, instead of a commit SHA. sealup's releases are immutable, so the tag cannot move. Workflows you already have keep working as they are; the [Action page](https://sealup.dev/github-action/) shows the SHA form for teams whose policy asks for one.

### Features

* **init:** asks whether the repository is public. On yes, `sealup.yml` holds `server: ${SEALUP_SERVER}` and `hostKey: ${SEALUP_HOST_KEY}` instead of the login name, server and host key; their values go in `sealup.env`, the workflow passes them from secrets, and the last screen lists each secret to add.
* **GitHub Actions:** a server, host key or certificate fingerprint read from a `${NAME}` variable is masked in GitHub's log before anything else is printed, and so is a key or certificate the server shows during the run. The job summary names the variable (`${SEALUP_SERVER}`) where it showed the server.
* **keyscan:** `--save` never writes over a `${NAME}` host key or fingerprint: it prints the new value and names the variable to update, in `sealup.env` and in CI. A changed host key read from a variable gives the same advice.

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
