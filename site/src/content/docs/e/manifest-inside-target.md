---
title: 'The manifest folder is public'
description: 'The manifest folder is inside a folder upload: sends files to, where visitors could download it.'
---

```text
  ✗ The manifest folder is inside /~/www: sealup stopped.
    /~/www/.sealup is in /~/www, where upload: sends files (line 2):
    visitors could download it.
    Move manifest: outside it; the default is .sealup in the login folder.

    sealup did not connect. Nothing was changed on production.
    More: sealup.dev/e/manifest-inside-target
```

**Exit code:** 2. **Server changed:** no.

## What happened

The manifest folder is a folder that an `upload:` entry sends files to, or inside one. With an entry that sends into the target folder itself (`public_html: .`), that is the whole target folder: the title then says "inside the target folder".

## Why

The manifest is the list of files sealup uploaded. In a folder sealup sends files to, the web server would serve it to anyone who asks.

The manifest folder may sit in the target folder beside those folders. With the target folder `/~` (the login folder) and `public_html: www`, `api: api`, the default `/~/.sealup` is fine: visitors reach `www/`, not the login folder. A single file sent into the target folder (`.ovhconfig: .ovhconfig`) does not count.

## The fix

Move `manifest:` out of every folder `upload:` sends to, or remove the key: the default is `.sealup` in the login folder. If an entry sends into the target folder itself and the default is inside it, either set `manifest:` to a folder outside the target folder, or send that entry into a folder below it.
