---
title: 'Too much to list'
description: 'A server folder holds more than sealup lists.'
---

```text
  ✗ www/resources holds over 100,000 entries: sealup stopped listing.
    sealup reads only that much from a server, so a broken or hostile one
    cannot keep it listing. Pull a smaller folder.

    More: sealup.dev/e/pull-too-large
```

**Exit code:** 6. **Server changed:** no: nothing was downloaded.

## What happened

A folder to pull is over a limit: 100,000 entries in one folder, 1,000,000 files in all, or 64 folders deep.

## Why

sealup reads only that much from a server, so a broken or hostile one cannot keep it listing without end.

## The fix

Pull a smaller folder: name its subfolders in `pull:` one by one.
