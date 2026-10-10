---
title: 'The file list is too large'
description: 'sealup''s file list (the manifest) on the server is larger than any it writes.'
---

```text
  ✗ sealup's file list on the server is too large to be trusted.
    Delete it from the manifest folder; the next deploy then starts afresh.

    More: sealup.dev/e/manifest-too-large
```

**Exit code:** 6. **Server changed:** no.

## What happened

The manifest on the server is over 50 MiB, more than sealup reads.

## Why

sealup reads only that much from a server, so a broken or hostile one cannot make it read without end. A list that large is not one sealup wrote for a site.

## The fix

Delete the file from the manifest folder (`.sealup/` in the login folder by default). The next deploy starts afresh: it sends every file and deletes none of the old ones.
