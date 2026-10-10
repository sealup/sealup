---
title: Private keys
description: Log in over SFTP or SSH with a private key instead of a password.
---

Over `sftp://` and `ssh://`, a target can log in with a private key instead of a password.
The key is the content of the key file, read from a variable like a password: never a path,
never written in `sealup.yml`.

```yaml
server: sftp://deploy@ssh.example.com/~
privateKey: ${DEPLOY_KEY}
passphrase: ${DEPLOY_KEY_PASSPHRASE}   # only for an encrypted key
hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86
upload:
  dist: www
```

A target has `password` or `privateKey`, never both and never neither. FTP and FTPS log in with
a password only.

## Make a key for deploys

Give deploys a key of their own, so you can revoke it without touching yours:

```sh
ssh-keygen -t ed25519 -f deploy_key -C "deploy key"
```

This writes `deploy_key` (the private key, for sealup) and `deploy_key.pub` (the public key,
for the server). Add the public key to the login's `~/.ssh/authorized_keys` on the server, or
through your host's control panel if it has a page for SSH keys. An empty passphrase is fine
for a key that lives only in a CI secret; give one to a key you keep on your computer, and set
`passphrase:`.

sealup reads OpenSSH private keys (what `ssh-keygen` writes today) and PEM RSA keys. It does
not read PuTTY's `.ppk` files.

## On your computer

Put the whole key file in `sealup.env`, in double quotes, over several lines:

```sh
DEPLOY_KEY="-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
…
-----END OPENSSH PRIVATE KEY-----"
```

On one line, `\n` inside double quotes is a line break too.

## In GitHub Actions

Paste the whole key file, `BEGIN` and `END` lines included, into a repository or environment
secret, and pass it to the sealup step under `env:`:

```yaml
- uses: sealup/sealup@<commit SHA> # vX.Y.Z
  env:
    DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}
```

Before it prints anything, sealup asks GitHub to mask every line of the key, so no line of it
can show in the log.

## What sealup checks

`sealup check` says how each target logs in, without connecting:

<!-- output: s06-check -->
```text
  ✓ Login: production with a password, staging with a private key
```

Before connecting, sealup reads the key on your machine. A key it cannot read, a missing
passphrase or a wrong one stops the run with exit 2, before anything reaches the server
([private-key-unreadable](/e/private-key-unreadable/)). A server that refuses the key is a
refused login: exit 3, never retried, so a host that bans after a few failures never bans you
([login-refused](/e/login-refused/)).

## Learn more

- [SFTP](/sftp/) and [SSH](/ssh/): the protocols that take a key.
- [`sealup.yml`](/config/): `privateKey`, `passphrase`.
