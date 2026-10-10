---
title: 'The file list cannot be read'
description: 'sealup cannot read its file list (the manifest) on the server.'
---

```text
  ✗ sealup cannot read its file list on the server.
    It is how sealup knows what it uploaded; a wrong list could make it delete
    the wrong files.
    Check it in the manifest folder, or delete it to start afresh.

    More: sealup.dev/e/manifest-unreadable
```

**Exit code:** 6. **Server changed:** no.

## What happened

The manifest, the file list sealup keeps on the server (in `.sealup/` by default), is there, but sealup cannot read it.

## Why

Most often its permissions changed, or another tool touched the manifest folder. Without the list sealup cannot tell which files it uploaded, so it stops before deleting anything.

## The fix

Check the file in the manifest folder: it must be readable by the user sealup logs in as. Or delete it: the next deploy then starts afresh, sending every file and deleting none of the old ones.
