---
title: 'Too much to list'
description: 'The server check or the mirror would list more than sealup reads from a server.'
---

```text
  ✗ The server check listed over 200,000 entries: sealup stopped listing.
    sealup reads only that much from a server, so a broken or hostile one
    cannot keep it listing. Deploy without the server check: drop
    --check-server, or checkServer: true in sealup.yml.

    Nothing was changed on production.
    More: sealup.dev/e/listing-too-large
```

**Exit code:** 6. **Server changed:** no: sealup stopped before any upload or delete.

## What happened

The server check (`--check-server`, or `checkServer: true` on the target) lists the folders that
hold the files sealup uploaded; the full mirror (`--mirror`, or `mirror: true` on an upload
entry) lists the whole mirrored folder. That listing passed a limit: 200,000 entries in all, or a
folder over 64 levels below the target folder.

## Why

sealup reads only that much from a server, so a broken or hostile one cannot keep it listing
without end. A partial listing never decides what to upload or delete.

## The fix

Deploy without the server check: drop `--check-server` from the command, or `checkServer: true`
from the target in `sealup.yml`. The deploy then trusts its file list on the server, as it does
by default.

For the mirror, the words say so:

```text
  ✗ The mirror listed over 200,000 entries: sealup stopped listing.
    sealup reads only that much from a server, so a broken or hostile one
    cannot keep it listing. Exclude the large server folders (never listed),
    or deploy without the mirror: drop --mirror, or mirror: true.
```

Exclude the large folders the site writes into (uploads, caches): an excluded folder is never
listed, so it counts for no limit. Or deploy without the mirror: drop `--mirror`, or
`mirror: true` from the upload entry. sealup then deletes only files it uploaded.
