---
title: 'Connection lost'
description: 'The connection to the server dropped while sealup was working.'
---

```text
  ✗ Upload stopped: the connection to ssh.example.com was lost.
    Most likely the network dropped, or the host closed the connection.

    More: sealup.dev/e/connection-lost
```

**Exit code:** 1 when some files had arrived, 5 before any change. **Server changed:** partly, when the error says so.

## What happened

The connection to the server ended in the middle of the run.

## Why

Most likely the network dropped, or the host closed the connection (some hosts end long sessions).

## The fix

Run the same command again. sealup recorded what arrived, so it sends only the missing files. Until then the site may serve a mix of old and new files; no old file was deleted, since sealup deletes only once every upload is in.
