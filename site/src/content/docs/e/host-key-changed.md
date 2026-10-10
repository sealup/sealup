---
title: 'The host key changed'
description: 'The server showed another key than the one saved in sealup.yml.'
---

```text
  ✗ The server's host key changed. sealup stopped before logging in.
    sealup.yml (line 4) expects one key; ssh.example.com sent another:
      expected  ED25519 SHA256:…
      received  ED25519 SHA256:…
    Either your host moved the site to a new server, or someone between you
    and the server is intercepting the connection.

    More: sealup.dev/e/host-key-changed
```

**Exit code:** 4. **Server changed:** no: the password was not sent.

## What happened

The server answered with a host key other than the `hostKey:` saved in `sealup.yml`. sealup stopped before logging in, so the password was not sent.

## Why

Either your host moved the site to a new server (a plan change, a migration), or someone between you and the server is posing as it.

## The fix

Ask your host for the server's fingerprint, in its panel or its support. If it is the received one, save the new key on your own machine and commit `sealup.yml`:

```sh
sealup keyscan production
```

`keyscan` asks before it replaces a saved key. If the fingerprint is not your host's, do not deploy: tell your host.
