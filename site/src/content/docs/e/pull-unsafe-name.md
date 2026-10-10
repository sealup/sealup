---
title: 'A server name this machine cannot hold'
description: 'A file on the server has a name that cannot be written here.'
---

```text
  ✗ www/resources/CON.txt cannot be pulled as it is named.
    Its name is reserved on Windows (CON, NUL, COM1, …).
    sealup stopped before writing anything here. Rename it on the server,
    or pull a folder that does not hold it.

    More: sealup.dev/e/pull-unsafe-name
```

**Exit code:** 6. **Server changed:** no: nothing was downloaded.

## What happened

A file or folder to pull has a name this machine cannot hold, or that could land elsewhere.

## Why

The names sealup refuses:

- a `/` or a `\` in a name, a control character, or an empty, `.` or `..` name;
- `< > : " | ? *`, a name reserved on Windows (`CON`, `NUL`, `COM1`, …), or one ending with a dot or a space, which Windows does not allow;
- a name not in the composed Unicode form (NFC), over 255 bytes, or shaped like sealup's own temp files.

sealup checks every name before it writes anything.

## The fix

Rename it on the server, or pull a folder that does not hold it.
