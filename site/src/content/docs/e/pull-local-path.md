---
title: 'A local path is in the way'
description: 'The local folder of a pull holds a link, or a file where a folder is needed.'
---

```text
  ✗ public_html/resources is a link: sealup pull stopped before writing anything.
    sealup does not write through links: one could lead outside the project.
    Put a real folder there, or pull into another folder.

    More: sealup.dev/e/pull-local-path
```

**Exit code:** 6. **Server changed:** no: nothing was downloaded.

## What happened

On this machine, the path a pull writes to goes through a link or a junction, or holds a file where a folder is needed (or the other way round).

## Why

A link could lead outside the project. And sealup never deletes a local file or folder to make room.

## The fix

Put a real folder there, move the file out of the way, or pull into another folder.
