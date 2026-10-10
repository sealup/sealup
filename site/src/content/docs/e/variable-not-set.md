---
title: 'A variable is not set'
description: 'sealup.yml reads a variable that is not in the environment or in sealup.env.'
---

```text
  ✗ SEALUP_PASSWORD is not set.
    password (sealup.yml line 3) reads ${SEALUP_PASSWORD}.
    sealup looked in the environment and in sealup.env.
    Add this line to sealup.env, next to sealup.yml:  SEALUP_PASSWORD=…

    More: sealup.dev/e/variable-not-set
```

**Exit code:** 2. **Server changed:** no.

## What happened

A line of `sealup.yml` reads `${NAME}`, and `NAME` has no value. sealup looked in the environment, then in `sealup.env` (or the file given to `--env-file`).

## Why

Secrets never go in `sealup.yml`: they come from variables. On your machine they usually live in `sealup.env`, which is git-ignored. In GitHub Actions a secret reaches sealup only when the workflow passes it to the step, and GitHub passes an empty value for a secret that does not exist, so the error says "empty or not set".

## The fix

**On your machine:** add the line to `sealup.env`, next to `sealup.yml`:

```sh
SEALUP_PASSWORD=…
```

**In GitHub Actions:**

1. Add the secret in the repository settings (Secrets and variables › Actions), or in the environment of the target.
2. Pass it under `env:` of the sealup step:

```yaml
env:
  SEALUP_PASSWORD: ${{ secrets.SEALUP_PASSWORD }}
```

A line written `${NAME:?message}` shows your own message here.
