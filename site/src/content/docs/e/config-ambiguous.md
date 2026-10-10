---
title: 'Two config files'
description: 'A folder holds both sealup.yml and sealup.yaml.'
---

```text
  ✗ Two config files in /home/me/site: sealup.yml and sealup.yaml.
    sealup will not guess which one counts. Keep one of them.

    More: sealup.dev/e/config-ambiguous
```

**Exit code:** 2. **Server changed:** no.

## What happened

The folder holds both `sealup.yml` and `sealup.yaml`.

## Why

They could say different things, and sealup will not guess which one counts.

## The fix

Keep one of them and delete or rename the other.
