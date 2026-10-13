<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://sealup.dev/brand/sealup-wordmark-on-dark.svg">
    <img src="https://sealup.dev/brand/sealup-wordmark.svg" alt="sealup" width="180">
  </picture>
</h1>

<p>
  <a href="https://github.com/sealup/sealup/actions/workflows/ci.yml"><img src="https://github.com/sealup/sealup/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/sealup"><img src="https://img.shields.io/npm/v/sealup" alt="npm version"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/sealup/sealup"><img src="https://api.scorecard.dev/projects/github.com/sealup/sealup/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://github.com/sealup/sealup/blob/main/LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence: MIT"></a>
</p>

**Seal it up, send it off:** sealup deploys your site, fast and safe, from your machine or CI to any hosting you can reach over SFTP, SSH or FTP, with one config and no secrets in the repo.

```text
$ npx sealup deploy production
  production  sftp://deploy@ssh.example.com:22/home/site
  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified

  First deploy: existing files stay. sealup only ever deletes files it uploaded.
  1,200 to upload                                                 1.2 MB

  ✓ Sealed up and delivered: 1,200 files to production in 15.6 s.
    https://example.com
```

A first deploy of 1,200 files over SFTP, exactly as sealup prints it in its own test of a first deploy, where the names are `example.com` ones and the time comes from the test's clock. The next deploy sends only what changed.

## Why

- **Only what changed goes up.** sealup keeps a list of what it uploaded on the server, and compares it with the SHA-256 of your files. A redeploy after a small change takes seconds, even over FTP.
- **Never a half-uploaded site.** Each file arrives under a temporary name and is renamed into place. sealup deletes only files it uploaded itself, and a dry run shows every change first.
- **No secrets in the repo.** Passwords and keys come from environment variables (`sealup.env` on your machine, secrets in CI). sealup never prints them, and refuses one written in the config.

## Quick start

On your machine, in your project (Node.js 24 or later):

```sh
npx sealup init               # asks for the server, checks its host key, writes sealup.yml
npx sealup deploy --dry-run   # dry run: lists every change, changes nothing
npx sealup deploy
```

In GitHub Actions, after your build step. `sealup init` writes this workflow for you, pinned to the release's version (releases are immutable, so the tag can't move); each release's notes give the line ready to copy:

<!-- x-release-please-start-version -->
```yaml
- uses: sealup/sealup@v0.2.1
  id: sealup
  env:
    SEALUP_PASSWORD: ${{ secrets.SEALUP_PASSWORD }}
```
<!-- x-release-please-end -->

## Config

`sealup.yml`, at the root of your project:

```yaml
server: sftp://deploy@ssh.example.com/home/site
password: ${SEALUP_PASSWORD}
hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86
url: https://example.com

upload:
  dist: www          # local folder: server folder
  api: api
exclude:
  - '**/*.map'
write:                   # files put on the server from a secret, on each deploy
  api/.env: ${API_ENV}   # the whole production .env in one secret, never on disk
pull:
  www/uploads: uploads   # brought back by `sealup pull`
```

The server URL says the protocol: `sftp://`, `ssh://` (SFTP, plus one `tar` stream for the uploads when the server has `tar`), `ftps://` (explicit TLS) or `ftp://` (plain, with a warning on every run). Logins take a password or a private key. Several targets (staging, production) go under `targets:`. Every key is on [sealup.dev](https://sealup.dev).

## Where it runs

| Where | Status |
|---|---|
| OVH shared hosting, over SFTP, SSH and FTP | Tested on a real account before each release |
| OpenSSH, Pure-FTPd, ProFTPD, vsftpd | Tested in containers on every change |
| Any other host | Best effort: it should work, and issues are welcome |

sealup runs wherever Node.js 24 runs, locally or in any CI; its own CI tests it on Linux and Windows. The GitHub Action runs the same code as the CLI.

## How releases are made

- The npm package is one bundled file with **no dependencies** and no install scripts.
- Each release is built in GitHub Actions from its tag, then published to npm through trusted publishing with **provenance**, and approved by the maintainer with 2FA.
- The GitHub release is **immutable**, with build attestations for the npm tarball and `dist/action.mjs`, and a `SHA256SUMS` file.
- Workflows pin every action to a full commit SHA and are checked by actionlint and zizmor.

To verify a release:

<!-- x-release-please-start-version -->
```sh
npm audit signatures                                     # in a project that installed sealup
v=0.2.1                                                  # the release to check
gh release download v$v --repo sealup/sealup --pattern "sealup-$v.tgz"
gh release verify v$v --repo sealup/sealup
gh release verify-asset v$v sealup-$v.tgz --repo sealup/sealup
gh attestation verify sealup-$v.tgz --repo sealup/sealup
```
<!-- x-release-please-end -->

## Links

- Docs: [sealup.dev](https://sealup.dev)
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md)
- Licence: [MIT](LICENSE)
