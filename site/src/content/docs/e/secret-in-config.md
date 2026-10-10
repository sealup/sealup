---
title: 'A password in sealup.yml'
description: 'sealup.yml holds a password written as it is, not a variable.'
---

```text
  ✗ sealup.yml holds a password: password (line 3).
    sealup takes passwords only from variables, so they stay out of git.
    1. Move the value to sealup.env (git-ignored):  SEALUP_PASSWORD=…
    2. Write this on line 3 instead:                password: ${SEALUP_PASSWORD}
    3. If sealup.yml was ever committed, the password is in your git history:
       change it with your host.

    More: sealup.dev/e/secret-in-config
```

**Exit code:** 2. **Server changed:** no.

## What happened

`password:` holds the password itself instead of a variable like `${SEALUP_PASSWORD}`.

## Why

`sealup.yml` is meant to be committed. A password in it ends up in git, and from there in every clone and fork. sealup stops before connecting rather than use it.

## The fix

1. Move the value to `sealup.env` (git-ignored): `SEALUP_PASSWORD=…`. In GitHub Actions, add it as a secret and pass it under `env:` of the sealup step.
2. Write `password: ${SEALUP_PASSWORD}` in `sealup.yml` instead. With several targets the variable is named after the target, like `PRODUCTION_PASSWORD`.
3. If the file was ever committed, the password is in your git history: change it with your host.

A `write:` entry that holds a file's content instead of one `${NAME}` is reported the same way, in the [config-invalid](/e/config-invalid/) list.
