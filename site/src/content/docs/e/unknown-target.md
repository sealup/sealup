---
title: 'No target of that name'
description: 'The command named a target that sealup.yml does not have.'
---

```text
  ✗ No target named prod in sealup.yml.
    Did you mean production?  sealup deploy production
    Targets in sealup.yml: staging, production.

    More: sealup.dev/e/unknown-target
```

**Exit code:** 2. **Server changed:** no.

## What happened

The target named in the command is not under `targets:` in `sealup.yml`.

## Why

Most often a typo, or a target that lives in another config file.

## The fix

Use one of the names the error lists; when one is close, sealup suggests it. To use another config file, point to it with `-c <file>`.
