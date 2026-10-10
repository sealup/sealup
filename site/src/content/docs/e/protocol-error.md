---
title: 'The server answered with a failure'
description: 'The server failed an operation, or did not answer as an SFTP server does.'
---

```text
  ✗ Upload stopped: ssh.example.com answered with a failure.
    It gave no reason. A full disk is the most likely one: OpenSSH says only
    "Failure" when the disk or the quota is full.
    Check the space in your hosting panel (old backups, logs, mailboxes).

    More: sealup.dev/e/protocol-error
```

**Exit code:** 1 when some files had arrived, 5 before any change. **Server changed:** partly, when the error says so.

## What happened

The server answered an operation with a failure and no reason, or did not answer as an SSH or SFTP server does: no SFTP for this user, no login folder, a handshake that did not finish.

## Why

During uploads a full disk is the most likely cause: OpenSSH answers only "Failure" when the disk or the quota is full. Before login, the address points to a server that does not offer SFTP to this user.

## The fix

- Check the space in your hosting panel (old backups, logs, mailboxes), then run the same command again: it sends only what is missing.
- Before login: check in your host's panel that SFTP is on for this user, and that `server:` names the SSH port.
