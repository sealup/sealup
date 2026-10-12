---
title: sealup keyscan
description: Show the server's host key and save it to sealup.yml.
sidebar:
  label: keyscan
---

Show the server's host key and save it to `sealup.yml` as `hostKey`, once you have compared its
fingerprint with your host's. sealup checks this key before it sends your password. `keyscan`
never logs in: it reads no password.

```sh
sealup keyscan [target] [flags]
```

## Why a host key

The host key proves the server is the one you set up. Without it, someone between you and the
server could pose as it and receive your password. So every deploy checks the key first, and
stops before logging in when it is missing ([host-key-missing](/e/host-key-missing/)) or
different ([host-key-changed](/e/host-key-changed/)).

Your host shows the server's fingerprint in its panel or its docs. Compare it with the one
`keyscan` prints before you save it.

## Target

- One target in `sealup.yml`: no name needed.
- Several targets: name one. Without a name, a terminal shows a picker, and CI stops with
  exit 2, listing the names.

## On a terminal

It asks before it saves the key, and before it replaces another saved key (no by default). Only
the `hostKey` line of `sealup.yml` changes.

## Without a terminal

It prints the `hostKey` line to paste and never writes: sealup never trusts a server key from
CI. Another key than the saved one: exit 4 ([host-key-not-replaced](/e/host-key-not-replaced/)).

## A key read from a variable

When `sealup.yml` reads the key from a variable (`hostKey: ${SEALUP_HOST_KEY}`, as a public
repository does), `keyscan` never writes over it and asks nothing. It prints the key line and
names the variable to set, in `sealup.env` and in your CI secrets. Another key than the
variable's: exit 4. The variable not set yet: it shows the key to set, exit 0. The same holds
for `tlsFingerprint` ([key-in-variable](/e/key-in-variable/)).

## A public repository without a saved key

When you answer that the repository is public but do not save the host key, `sealup init`
reads the server from `${SEALUP_SERVER}` and leaves the comment
`# hostKey: run sealup keyscan on your computer` in `sealup.yml`. `keyscan` would then save the
key there in plain text, and the key can be looked up to find the server. Replace the comment
with the reference first:

```yaml
hostKey: ${SEALUP_HOST_KEY}
```

Then run `sealup keyscan`: it saves nothing and prints the key line. Once you have compared its
fingerprint with your host's, set `SEALUP_HOST_KEY` to that line in `sealup.env` and as a secret
in CI, and pass it in the workflow's `env:` beside `SEALUP_SERVER`:

```yaml
SEALUP_HOST_KEY: ${{ secrets.SEALUP_HOST_KEY }}
```

If `keyscan` already saved the key in the file, do the same by hand: move the `hostKey` value to
`SEALUP_HOST_KEY` in `sealup.env` and in CI, and write `hostKey: ${SEALUP_HOST_KEY}` in its
place.

## FTPS and FTP

An `ftps://` server has no host key: its TLS certificate stands for it. `keyscan` shows the
certificate's subject, issuer, dates and SHA-256, and what the normal check says (a known
authority signs it, for the host in `server`), without sending your user name.

- The normal check passes: nothing to pin. Every deploy checks the certificate as a browser does.
- It fails (a self-signed certificate, or one made for the host's own name, common on shared
  hosting): on a terminal, after you have compared the SHA-256 with your host's, it offers to
  save it as `tlsFingerprint`; without a terminal it prints the line to paste. With a pin, the
  server must show that certificate, and the CA and name checks are no longer made.
- Another certificate than the pinned one: exit 4 unless you replace the pin on a terminal
  ([certificate-refused](/e/certificate-refused/)).

A plain `ftp://` server has nothing to trust: `keyscan` says so and exits 0.

Global flags: `-c`, `--env-file`, `--json`, `--no-color` (see `sealup --help`).

## Examples

```sh
sealup keyscan                   # the only target
sealup keyscan staging           # one of several targets
```

## Learn more

- [Exit codes](/exit-codes/): 4, the server is not the one in `sealup.yml`.
