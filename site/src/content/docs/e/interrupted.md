---
title: 'Interrupted'
description: 'sealup was stopped with Ctrl-C.'
---

```text
  ✗ Stopped: sealup was interrupted (Ctrl-C).
    The transfers in flight finished; no new one started.

    More: sealup.dev/e/interrupted
```

**Exit code:** 130. **Server changed:** maybe: the last line says.

## What happened

sealup got Ctrl-C (or the CI job was cancelled) while it ran.

## Why

sealup lets the transfers in flight finish, so no file is left half-written, and starts no new one.

## The fix

Read the last line: it says what the server has now. Run the same command again to finish: sealup sends only what is missing.
