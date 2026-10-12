---
title: 'The key is read from a variable'
description: 'sealup.yml reads hostKey or tlsFingerprint from a variable, so keyscan never writes it: you set the variable.'
---

```text
  ✗ The server's host key changed. sealup.yml was not changed.
    sealup.yml (line 4) expects one key; ssh.example.com sent another:
      expected  ED25519 SHA256:…
      received  ED25519 SHA256:…
    Either your host moved the site to a new server, or someone between you
    and the server is intercepting the connection.
    sealup.yml reads hostKey from a variable, which sealup never writes.
    Ask your host for the server's fingerprint. If it is the received one,
    set SEALUP_HOST_KEY to this line in sealup.env and in CI:
      ssh-ed25519 AAAA…

    Nothing was changed.
    More: sealup.dev/e/key-in-variable
```

**Exit code:** 4 when the server shows another key or certificate than the variable holds; 0
when the variable is not set yet. **Server changed:** no.

## What happened

`sealup keyscan` found a key to save, but `sealup.yml` reads `hostKey` (or, over FTPS,
`tlsFingerprint`) from a variable, such as `hostKey: ${SEALUP_HOST_KEY}`. sealup never writes
over a variable, so it changed nothing, asked nothing, and printed the value to set.

## Why

A public repository keeps its server and host key out of `sealup.yml`: the values live in
`sealup.env` on your machine and in your CI secrets. Only you can update those two places.

When the variable is not set yet, `keyscan` still scans the server and shows the value to set.
When it is set and the server shows another key, the deploy stops before logging in until you
update it: either your host moved the site to a new server, or someone between you and the
server is posing as it.

## The fix

Ask your host for the server's fingerprint (or, over FTPS, the certificate's SHA-256). If it is
the one `keyscan` received, set the variable to the line it printed, in two places:

- `sealup.env`, next to `sealup.yml`, for runs on your machine:

  ```sh
  SEALUP_HOST_KEY=ssh-ed25519 AAAA…
  ```

- your CI secrets, for runs in CI: in GitHub, the repository's or the environment's secret of
  the same name.

Then run `sealup keyscan` again: it says the key is already saved.
