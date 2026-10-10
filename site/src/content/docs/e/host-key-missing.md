---
title: 'No host key'
description: 'The target has no hostKey, so sealup cannot confirm the server is yours.'
---

```text
  ✗ sealup cannot confirm this server is yours: there is no host key.
    It checks the server first, so an impostor never receives the password.
    Run on your machine:  sealup keyscan production
    It shows the key for you to confirm and writes hostKey into sealup.yml.
    Commit that line.

    More: sealup.dev/e/host-key-missing
```

**Exit code:** 4. **Server changed:** no.

## What happened

The target has no `hostKey:` line, and sealup did not connect.

## Why

Before it sends the password, sealup checks that the server shows the key saved in `sealup.yml`. Without a saved key there is nothing to check against, and sealup never trusts a new key on its own: in CI it could be anyone's.

## The fix

On your own machine, run [`sealup keyscan`](/keyscan/) for the target, compare the fingerprint with the one your host shows, and answer yes. Then commit the `hostKey:` line.

```sh
sealup keyscan production
```
