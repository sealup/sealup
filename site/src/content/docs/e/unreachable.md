---
title: 'Cannot reach the server'
description: 'sealup could not connect to the server at that address and port.'
---

```text
  ✗ Cannot reach ssh.example.com:22.
    No answer from the server in 30 s.
    Check the host and port in server (sealup.yml line 1),
    and that the server is up.

    More: sealup.dev/e/unreachable
```

**Exit code:** 5. **Server changed:** no.

## What happened

sealup could not open a connection to the server, or the connection ended before login. The second line says how: no host of that name, the connection refused on that port, no route to the host, no answer in time, or the server closing the connection.

## Why

Most often a typo in the host or the port, a server that is down, or a host that lets SSH in only from some IP addresses.

## The fix

- Check the host and the port in `server:`.
- Check that the server is up, and that your host allows SSH from where sealup runs (some hosts list allowed IP addresses in their panel).
- Then run the same command again.
