---
title: 'A file uploaded and excluded'
description: 'A single file in sealup.yml is both uploaded and excluded.'
---

```text
  ✗ A single file in sealup.yml is both uploaded and excluded.
    upload.config.php (line 5) sends it,
    and exclude (line 8) leaves it out.
    sealup will not guess which one wins: change one of the two lines.

    More: sealup.dev/e/excluded-file
```

**Exit code:** 2. **Server changed:** no.

## What happened

An `upload:` entry names one file, and an `exclude:` pattern matches it.

## Why

The two lines ask for opposite things, and sealup will not guess which one wins.

## The fix

Remove the file from `exclude:`, or remove its `upload:` entry.
