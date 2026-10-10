---
title: 'A file name a server cannot hold'
description: 'A file in the build has a name that cannot be a path on a server.'
---

```text
  ✗ dist/notes\draft.txt cannot be sent as it is named.
    Its name holds a \, which a server could read as a folder separator.
    Rename it, or leave it out with exclude in sealup.yml.

    More: sealup.dev/e/bad-local-name
```

**Exit code:** 6. **Server changed:** no.

## What happened

A file to upload has a name that cannot be a path on the server: a control character (a line break, a tab), a `\`, or a start like a Windows drive (`C:`).

## Why

On the server such a name could land in another folder than the one you meant, or not at all. sealup checks every name before it connects.

## The fix

Rename the file, or leave it out with `exclude:` in `sealup.yml`.
