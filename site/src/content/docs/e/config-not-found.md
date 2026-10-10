---
title: 'No sealup.yml here'
description: 'sealup found no sealup.yml in this folder or the folders above it.'
---

```text
  ✗ There is no sealup.yml here.
    sealup looked in /home/me/site
    and each folder above it up to the repo root, /home/me/site
    Run sealup in the folder that holds sealup.yml, or point to it with -c <file>.

    More: sealup.dev/e/config-not-found
```

**Exit code:** 2. **Server changed:** no.

## What happened

sealup looked for `sealup.yml` (or `sealup.yaml`) in the current folder and each folder above it, up to the repo root, and found none.

## Why

Either the project is not set up yet, or the command ran in another folder.

## The fix

- Run sealup in the folder that holds `sealup.yml`, or point to the file with `-c <file>`.
- To set up the project, run [`sealup init`](/init/).
