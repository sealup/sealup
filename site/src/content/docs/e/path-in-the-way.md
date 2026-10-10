---
title: 'A path is in the way'
description: 'The build needs a folder where the server has a file, or the other way round.'
---

```text
  ✗ www/docs is a file; the build needs a folder there.
    sealup did not upload it, and deletes only what it uploaded.
    Move it out of the way on the server, or rename it in your build.

    More: sealup.dev/e/path-in-the-way
```

**Exit code:** 6 before any change, 1 after. **Server changed:** no, unless the error says so.

## What happened

Where the build has a folder, the server has a file (or the other way round), and sealup may not remove it.

## Why

sealup deletes only what it uploaded, and never an excluded path. This file or folder is one of those, so it stays, and the build cannot land there.

## The fix

Move it out of the way on the server, or rename the path in your build. When it holds files you excluded on purpose, move them first. Then run the same command again.
