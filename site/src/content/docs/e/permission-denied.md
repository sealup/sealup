---
title: 'Permission denied'
description: 'The server refused a change: the user may not write there.'
---

```text
  ✗ Upload stopped: ssh.example.com refused a change: permission denied.
    Check that deploy may write in /home/site/www on ssh.example.com.

    More: sealup.dev/e/permission-denied
```

**Exit code:** 1 when some files had arrived, 5 before any change. **Server changed:** partly, when the error says so.

## What happened

The server refused to create, replace or delete a file or folder, because the user sealup logs in as may not.

## Why

The target folder, or a file in it, belongs to another user or has modes that keep this user out. A folder made by the web server (an upload folder, a cache) often does.

## The fix

Check that the user in `server:` may write in the target folder, in your host's panel or with your host. Leave out files sealup must not touch with `exclude:`. Then run the same command again.
