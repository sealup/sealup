---
title: 'Out of space'
description: 'The server has no space left, or the account is over its quota.'
---

```text
  ✗ Upload stopped: production is out of space.
    ssh.example.com refused 12 files: no space left (quota full).
    Free space in your hosting panel (old backups, logs, mailboxes).

    More: sealup.dev/e/quota-full
```

**Exit code:** 1 when some files had arrived, 5 before any change. **Server changed:** partly: what arrived stays, and the old files are kept.

## What happened

The server refused files because the disk or the account quota is full.

## Why

Shared hosting counts everything against one quota: the site, its backups, logs and mailboxes.

## The fix

Free space in your hosting panel (old backups, logs, mailboxes), then run the same command again. sealup recorded what arrived, so it sends only the missing files. Until then the site may serve a mix of old and new files; no old file was deleted, since sealup deletes only once every upload is in.
