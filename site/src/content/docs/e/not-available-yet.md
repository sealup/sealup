---
title: 'Not available yet'
description: 'sealup.yml or the command asks for something this version does not do.'
---

```text
  ✗ --mirror is not available yet in this version.
    sealup stops rather than ignore it.

    More: sealup.dev/e/not-available-yet
```

**Exit code:** 2. **Server changed:** no.

## What happened

A key or a value names a feature that this version of sealup does not have yet.

## Why

Ignoring it could do something you did not ask for: a deploy with a safety net turned off. No key or value of this version stops with this error: it is kept for the features of later versions.

## The fix

Use what this version offers: an `sftp://` or `ssh://` server with a password or a private key, or an `ftps://` or `ftp://` server with a password. Or remove the value, and run the command again.
