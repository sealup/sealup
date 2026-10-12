---
title: 'Two entries send one path'
description: 'Two upload entries of sealup.yml send the same server path.'
---

```text
  ✗ Two entries in sealup.yml send www/robots.txt.
    upload.public/robots.txt (line 5) sends it,
    and so does upload.dist (line 4).
    sealup will not guess which one wins: change one of the two lines.

    More: sealup.dev/e/same-server-path
```

**Exit code:** 2. **Server changed:** no.

## What happened

Two `upload:` entries put a file at the same place on the server.

## Why

Only one of them can land there, and sealup will not guess which one you meant.

## The fix

Change one of the two lines: another server path, or leave the file out of one of them.

The same goes for a `write:` entry on a path an upload sends, or two `write:` entries on one
path: the file comes from the build or from a secret, not both (see
[Files written from a secret](/write/)).
