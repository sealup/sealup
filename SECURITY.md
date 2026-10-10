# Security policy

sealup holds the keys to your servers: the logins of every site it deploys. This page says how to report a flaw, what sealup does to keep those logins and your files safe, and where its protection stops.

## Supported versions

| Version | Security fixes |
|---|---|
| The latest 0.x minor | Yes, as a patch release |
| Older versions | No: update to the latest |

sealup bundles its libraries (`ssh2`, `basic-ftp`, `yaml`, `zod`) into one file, so a fix in one of them reaches you only through a sealup release. Such a fix ships as a patch release within days of the library's.

## Reporting a vulnerability

Report it privately through GitHub: [**Report a vulnerability**](https://github.com/sealup/sealup/security/advisories/new) (the repo's Security tab). Please never open a public issue for a security flaw.

Include what you can:

- the sealup version, the protocol (`sftp://`, `ssh://`, `ftps://`, `ftp://`) and the server software if you know it;
- the steps or a config that shows the flaw, with fake hosts and secrets;
- what an attacker gains.

You get an answer within 7 days. Once a fix is out, the advisory is published with credit to you, unless you prefer otherwise.

## What sealup protects

- **Your server logins and app secrets:** passwords, private keys and passphrases, and the secrets sealup writes into files on the server (an `.env`, for example).
- **Your website's files:** sealup must never write or delete outside the folder you gave it, and never leave a site half-uploaded.

## How sealup keeps your credentials safe

- Secrets come only from environment variables (`${NAME}` in `sealup.yml`; `sealup.env` on your machine, secrets in CI). A secret written in the config is refused, and the error names the key, never the value.
- Secrets are never printed. All output goes through one writer that masks each secret and its encoded forms (base64, URL-encoded, JSON-escaped, hex, each line of a key). In GitHub Actions every secret is registered with `::add-mask::` before the first line of output. sealup's CI runs every command and failure path with canary secrets and fails on any trace of them.
- No secret goes on a command line: sealup has no `--password` flag and starts no local process or shell.
- The server is checked before the login is sent. SSH and SFTP need the server's host key in the config (`sealup keyscan` shows it once, for you to compare and save; CI never trusts a key on first sight). FTPS checks the certificate and host name, or a pinned certificate fingerprint; a server that refuses TLS stops the run, with no fallback to plain FTP. FTP data connections go only to the host you named.
- A file written from a secret never touches your disk. It is uploaded under a hidden random name, given mode `0600`, then renamed. sealup refuses to write it into a folder visitors can browse (unless you say that folder isn't served), and stops if the server can't set its mode.

## How sealup protects your files

- One strict path rule for every path from your config, the server or sealup's own records: no `..`, no absolute paths, no control characters, and always inside the target folder.
- No writes through symbolic links: sealup checks each folder of the path on the server first, and a link stops the run unless you allow links. Deletes never follow a link.
- By default sealup deletes only files it uploaded itself, and never excluded ones. Full mirror (`mirror: true`) is opt-in, never deletes excluded paths, and refuses the server's root or login folder unless you say so.
- Each file arrives under a temporary name and is renamed into place, so visitors never see half a file. Leftovers of an interrupted run are removed by the next one.
- The record of uploaded files lives in `.sealup/` in the login folder, out of the web root. A lock there keeps two runs from deploying to the same target at once.
- A dry run (`sealup deploy -n`) shows every change before anything happens.

## How sealup ships

- The npm package is one bundled file: **no runtime dependencies, no install scripts**. Dependencies are pinned to exact versions, installed with `--ignore-scripts`, and updated by Dependabot only after 7 days.
- Releases are built in GitHub Actions from a protected tag and published to npm through **trusted publishing** (no npm token exists), with **provenance**. Each publish waits for the maintainer's approval with 2FA.
- GitHub releases are **immutable**. The npm tarball and `dist/action.mjs` carry build attestations, and a `SHA256SUMS` file lists both.
- Every workflow pins its actions to full commit SHAs, reads contents only unless a job needs more, and is checked by actionlint, zizmor and a weekly OpenSSF Scorecard.

To verify a release (here 0.1.0):

```sh
npm audit signatures                                     # in a project that installed sealup
gh release verify v0.1.0 --repo sealup/sealup
gh release verify-asset v0.1.0 sealup-0.1.0.tgz --repo sealup/sealup
gh attestation verify sealup-0.1.0.tgz --repo sealup/sealup
gh attestation verify action.mjs --repo sealup/sealup
sha256sum -c SHA256SUMS                                  # beside the downloaded assets
```

## What you should do

- Pin the action to a full commit SHA (`sealup/sealup@<sha> # vX.Y.Z`), as `sealup init` writes it.
- Give each site its own deploy user, limited to the smallest folder it needs.
- Prefer `sftp://` or `ssh://`, with a private key, over FTP.
- Keep production secrets in a GitHub environment or behind a protected branch. The server and host key can be `${NAME}` references too, so a changed `sealup.yml` can't send your password elsewhere.
- Rotate a password or key at once if it may have leaked.

## Known limits

- **Plain FTP (`ftp://`) sends your password in clear,** and has no way to check the server's identity. sealup warns on every such run. Use `ftps://` or `sftp://` where the host offers them.
- **vsftpd gives coarse file dates.** It offers no `MLSD`, so sealup reads its `LIST`, whose dates are to the minute (to the day for older files). `--check-server` can then miss a file edited on the server within that window if its size didn't change, and `pull` can take such a file for the one it already has.
- **Anyone who can push a workflow can change what it does,** including sending secrets elsewhere. Protect production with environments and branch rules.
- **Isolation between accounts on a shared host is the host's job.** sealup can't protect files from another user or process on the same server.
- **A pinned host key or certificate is only as good as your first check.** Compare the fingerprint `sealup keyscan` shows with the one in your host's control panel.
