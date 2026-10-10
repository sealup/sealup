---
title: 'Another protocol on that port'
description: 'The port in an sftp:// or ssh:// address answered as an FTP server does, so there is no SSH there.'
---

```text
  ✗ No SFTP server at ssh.example.com:21: this port speaks FTP.
    It answered with an FTP greeting (220), not an SSH one.
    SFTP is usually port 22: remove :21 from server (sealup.yml line 4).

    sealup did not log in. Nothing was changed on production.
    More: sealup.dev/e/wrong-protocol
```

**Exit code:** 5. **Server changed:** no.

## What happened

sealup reached the server, but the port in `server:` greeted it as an FTP server does (a line starting with `220`), not with SSH's greeting. SFTP and `ssh://` run over SSH. sealup stopped right there: no user name or password was sent.

## Why

The port in the address is the FTP one, most often 21. Or the host offers only FTP at that address.

## The fix

Use the SSH port your host gives: 22 by default, so remove the port from the address, or write the one your host names:

```yaml
server: sftp://deploy@ssh.example.com/home/site/www
```

If the host offers only FTP, write `ftp://` instead. Plain FTP sends your password and files unencrypted: sealup says so on every run.
