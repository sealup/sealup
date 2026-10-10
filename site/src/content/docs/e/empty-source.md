---
title: 'The build folder is empty'
description: 'A folder to upload is empty or missing, so sealup stopped before connecting.'
---

```text
  ✗ dist/ is empty: sealup stopped before connecting.
    An empty folder would delete the site: every file sealup put in www/.
    Most likely the build failed or wrote its files somewhere else.
    Run your build, check that it fills dist/, then deploy again.

    More: sealup.dev/e/empty-source
```

**Exit code:** 6. **Server changed:** no.

## What happened

A folder of `upload:` is empty, or is not there at all.

## Why

sealup deletes the files it uploaded before once they are gone from the build. An empty build would delete the whole site. Most likely the build failed, or wrote its files somewhere else.

## The fix

- Run your build and check that it fills the folder, then deploy again.
- In CI, check the build step before sealup: it must make the folder.
- If the entry is gone for good, remove it from `upload:`.
- To send an empty folder on purpose, add `allow: [empty-source]` to the target.
