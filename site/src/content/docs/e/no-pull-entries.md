---
title: 'Nothing to pull'
description: 'The target has no pull: entries.'
---

```text
  ✗ sealup.yml has no pull: entries for production.
    Add the server folder to copy and the local folder it goes to, like:
      pull:
        www/resources: public_html/resources

    More: sealup.dev/e/no-pull-entries
```

**Exit code:** 2. **Server changed:** no: nothing was downloaded.

## What happened

`sealup pull` found no `pull:` entry for the target.

## Why

sealup copies only the folders you name, never the whole server.

## The fix

Add the server folder to copy and the local folder it goes to:

```yaml
pull:
  www/resources: public_html/resources
```
