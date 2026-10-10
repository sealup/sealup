---
title: SFTP
description: Deploy over SFTP, the protocol to use when your host offers it.
---

SFTP is file transfer over SSH: encrypted, and the server proves who it is with its host key.
Most hosts offer it, often on their cheapest plan. Use it whenever you can.

```yaml
server: sftp://deploy@ssh.example.com/~
password: ${SEALUP_PASSWORD}
hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86
upload:
  dist: www
```

## The address

`sftp://user@host[:port]/folder`. The port is 22 unless you write another. The folder is
absolute (`/home/site/www`), or in the login folder when it starts with `/~` (`/~` is the login
folder itself). The user never carries a password: `sftp://user:password@…` is refused.

## The host key

`hostKey` is the server's public key, as `sealup keyscan` (or `sealup init`) saves it after you
compare its fingerprint with your host's. Every run checks it before it sends your password or
key. Without one, a deploy stops before connecting ([host-key-missing](/e/host-key-missing/));
with another one, it stops before logging in ([host-key-changed](/e/host-key-changed/)). See
[`sealup keyscan`](/keyscan/).

<!-- output: s07-first-deploy -->
```text
  production  sftp://deploy@ssh.example.com:22/home/site
  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
```

## Login

`password: ${NAME}`, or `privateKey: ${NAME}` (with `passphrase:` for an encrypted key): see
[Private keys](/private-keys/). A refused login stops at once and is never retried, so a host
that bans after a few failures never bans you ([login-refused](/e/login-refused/)).

## How files travel

- Each changed file is written under a hidden temporary name in its folder, then renamed to its
  real name, so a visitor never gets half a file. Deletes run last.
- sealup keeps many requests in flight on one connection: `parallel` is the number of SFTP
  requests at once (64 by default), over two SFTP channels where the server allows them.
- A connection that drops during the transfer is opened again, up to three times, and the run
  sends only what is left (the host key is checked again first).

## Speed

A first deploy sends every file; the next ones send only what changed, compared with sealup's
list on the server. A server with SSH and `tar` can take changed files as one archive: write
[`ssh://`](/ssh/).

## Learn more

- [SSH](/ssh/): SFTP plus one archive for the uploads.
- [`sealup.yml`](/config/): `server`, `hostKey`, `parallel`, `timeout`.
- [wrong-protocol](/e/wrong-protocol/): the port speaks FTP, not SFTP.
