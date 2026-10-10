---
title: 'The file list cannot be trusted'
description: 'sealup''s file list (the manifest) on the server is not one it wrote.'
---

```text
  ✗ sealup's file list on the server cannot be trusted.
    It is how sealup knows what it uploaded; a wrong list could make it delete
    the wrong files.
    Delete it from the manifest folder; the next deploy then starts afresh.

    More: sealup.dev/e/manifest-invalid
```

**Exit code:** 6. **Server changed:** no.

## What happened

sealup read its manifest on the server, and it is not a file list sealup could have written: cut short, edited, or of a format this version does not know.

## Why

A wrong list could make sealup delete the wrong files, so it stops before changing anything.

## The fix

Delete the file from the manifest folder (`.sealup/` in the login folder by default). The next deploy starts afresh: it sends every file and deletes none of the old ones.
