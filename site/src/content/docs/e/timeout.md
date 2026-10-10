---
title: 'The server stopped answering'
description: 'The server did not answer within the timeout.'
---

```text
  ✗ Upload stopped: ssh.example.com stopped answering.
    No answer from the server in 30 s.
    If the host is slow at times, raise timeout in sealup.yml (timeout: 2m).

    More: sealup.dev/e/timeout
```

**Exit code:** 1 when some files had arrived, 5 before any change. **Server changed:** partly, when the error says so.

## What happened

An operation on the server got no answer within the timeout (30 s by default).

## Why

The server is overloaded or slow at times, or the network is.

## The fix

Run the same command again: it sends only what is missing. If the host is slow at times, raise the timeout in `sealup.yml`:

```yaml
timeout: 2m
```
