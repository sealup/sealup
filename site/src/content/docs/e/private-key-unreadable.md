---
title: 'Private key cannot be read'
description: 'sealup cannot read the private key, or its passphrase does not open it.'
---

```text
  ✗ sealup cannot read the private key in DEPLOY_KEY.
    targets.production.privateKey (sealup.yml line 5) reads ${DEPLOY_KEY}.
    It must be the whole key file (OpenSSH or PEM), as ssh-keygen writes it,
    with its BEGIN and END lines.
    In sealup.env, write it in double quotes, over several lines.

    sealup did not connect. Nothing was changed on production.
    More: sealup.dev/e/private-key-unreadable
```

**Exit code:** 2. **Server changed:** no.

## What happened

The target logs in with `privateKey:`, and sealup could not use the key. It reads the key on your machine before it connects, so nothing reached the server. There are three cases:

- **The key cannot be read:** the variable does not hold a private key file. It may hold a path, a public key (`ssh-ed25519 AAAA…`), or a key cut short.
- **The key needs a passphrase:** the key is encrypted, and the target has no `passphrase:`.
- **The passphrase does not open the key:** `passphrase:` reads a variable that is not this key's passphrase.

## Why

A key is several lines, and they are easy to lose on the way: a value written on one line, a copy without its `-----BEGIN` or `-----END` line, or a secret pasted in part. sealup reads OpenSSH keys (`-----BEGIN OPENSSH PRIVATE KEY-----`, what `ssh-keygen` writes today) and PEM RSA keys. It does not read PuTTY's `.ppk` files or PKCS#8 keys.

## The fix

- Put the whole key file in the variable, line breaks included. In `sealup.env`, write it in double quotes over several lines:

  ```text
  DEPLOY_KEY="-----BEGIN OPENSSH PRIVATE KEY-----
  b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
  …
  -----END OPENSSH PRIVATE KEY-----"
  ```

  On one line, `\n` inside double quotes is a line break too. In GitHub Actions, paste the whole file into the secret and pass it under `env:` of the sealup step.
- For an encrypted key, add `passphrase: ${DEPLOY_KEY_PASSPHRASE}` next to `privateKey:` and set that variable.
- For a wrong passphrase, check that the key and the passphrase belong together.

`privateKey` and `passphrase` take a variable only, never the key itself: `sealup.yml` is meant to be committed.
