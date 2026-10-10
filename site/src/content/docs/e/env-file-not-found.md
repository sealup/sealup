---
title: 'No env file at that path'
description: 'The file given to --env-file does not exist.'
---

```text
  ✗ There is no env file at secrets/prod.env.
    Check the path given to --env-file.

    More: sealup.dev/e/env-file-not-found
```

**Exit code:** 2. **Server changed:** no.

## What happened

The file given to `--env-file` is not there.

## Why

A file you name yourself must exist: a typo would otherwise run with no variables. (Without the flag, a missing `sealup.env` is fine: the variables then come from the environment.)

## The fix

Check the path given to `--env-file`. It is read from the current folder.
