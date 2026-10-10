---
title: 'TLS refused'
description: 'An ftps:// server refused AUTH TLS, so sealup stopped before sending the user name.'
---

```text
  ✗ ftp.example.com refused TLS. sealup stopped before logging in.
    The server refused TLS (AUTH TLS): Command not implemented.
    sealup never falls back to plain FTP. Check the port in server
    (sealup.yml line 4): FTPS here is explicit TLS, usually on port 21.

    The password was not sent. Nothing was changed on production.
    More: sealup.dev/e/tls-refused
```

**Exit code:** 4. **Server changed:** no: the user name and password were not sent.

## What happened

`ftps://` is FTP with explicit TLS: sealup connects to the port in `server` (21 by default) and asks for TLS with `AUTH TLS` before anything else. The server said no, or would not protect the file transfers (`PROT P`).

## Why

The server offers no FTPS on that port. sealup never falls back to plain FTP: your password would travel unencrypted.

## The fix

- Check the port in `server`. sealup speaks explicit TLS; implicit TLS (usually port 990) is not supported.
- Ask your host whether FTPS is offered, and on which port. Most hosts also offer SFTP: write `sftp://` in `server` and run `sealup keyscan`.
- Only if the host offers plain FTP alone, write `ftp://`: sealup then warns on every run that the password and files travel unencrypted.
