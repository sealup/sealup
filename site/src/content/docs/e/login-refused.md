---
title: 'Login refused'
description: 'The server refused the user name or the password.'
---

```text
  ✗ Login refused by ssh.example.com for user deploy.
    Check the password in SEALUP_PASSWORD (password).
    sealup never retries a refused login: hosts block an IP after failures.

    More: sealup.dev/e/login-refused
```

**Exit code:** 3. **Server changed:** no.

## What happened

The server checked the user name and the password, or the private key, and refused them.

## Why

Most often the password in the variable is old or mistyped, or the user name in `server:` is not the SFTP one. Some hosts use a different user for SFTP than for their panel. With `privateKey:`, the server does not hold the key's public half for that user.

## The fix

- Check the password in the variable the error names (in `sealup.env`, or the secret in CI).
- With `privateKey:`, check that the key's public line (`ssh-ed25519 AAAA…`) is in `~/.ssh/authorized_keys` for that user on the server, or added in your host's panel.
- Check the user in `server: sftp://user@host/folder`.
- Check in your host's panel that SFTP is on for that user.

sealup never retries a refused login: many hosts block an IP address after a few failures. Fix the cause, then run the command again.
