---
title: 'No such file or folder on the server'
description: 'A path sealup needed on the server is not there.'
---

```text
  ✗ Cannot list the folder www/resources: no such file or folder.

    More: sealup.dev/e/server-not-found
```

**Exit code:** 1 when some files had arrived, 5 before any change. **Server changed:** no, unless the error says so.

## What happened

sealup asked the server for a file or folder, and the server answered that it does not exist.

## Why

With `sealup pull`, most often the server folder of a `pull:` entry is not there. With a deploy, a folder above the login folder that sealup may not create, or a file removed by hand while sealup ran.

## The fix

Check the path the error names: the folder in `server:`, or the server side of the `pull:` entry. Then run the same command again.
