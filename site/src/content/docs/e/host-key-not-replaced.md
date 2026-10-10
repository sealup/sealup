---
title: 'The host key was not replaced'
description: 'The server shows another key, and the one in sealup.yml was kept.'
---

```text
  ✗ The server's host key changed. sealup.yml was not changed.
    sealup.yml (line 4) expects one key; ssh.example.com sent another:
      expected  ED25519 SHA256:…
      received  ED25519 SHA256:…

    More: sealup.dev/e/host-key-not-replaced
```

**Exit code:** 4. **Server changed:** no.

## What happened

`sealup keyscan` found another key on the server than the one saved, and kept the saved one: you answered no, or it ran without a terminal.

## Why

Either your host moved the site to a new server, or someone between you and the server is posing as it. sealup never replaces a key without a yes on a terminal. A deploy stops before logging in while the server shows the other key.

## The fix

Ask your host for the server's fingerprint. If it is the received one, run on a terminal and answer yes, then commit `sealup.yml`:

```sh
sealup keyscan production
```
