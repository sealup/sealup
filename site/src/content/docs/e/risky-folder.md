---
title: 'A mirror into the root or the login folder'
description: 'With the mirror on, the target folder is the server root or the login folder, so sealup stopped before any change.'
---

Found in `sealup.yml`, before connecting:

```text
  ✗ The target folder /~ is the login folder: sealup stopped before connecting.
    With the mirror on, sealup deletes every file that is not in the build
    from /~/api and /~/www.
    It mirrors from the login folder only when you allow it.
    Deploy into a folder inside it, or drop --mirror.
    To mirror it on purpose: allow: [root-folder] on the target.

    Nothing was changed on production.
    More: sealup.dev/e/risky-folder
```

Found right after login, when the folder written in full is the login folder:

```text
  ✗ The target folder /home/deploy is the login folder: sealup stopped.
    With the mirror on, sealup deletes every file there that is not in the
    build, whatever else the account holds.
    Deploy into a folder inside it, or turn the mirror off (line 2).
    To mirror it on purpose: allow: [root-folder] on the target.

    Nothing was changed on production.
    More: sealup.dev/e/risky-folder
```

**Exit code:** 6. **Server changed:** no.

## What happened

The mirror is on, with `--mirror` or with `mirror: true` on an upload entry, and the target
folder is the server's root (`/`) or the login folder (`/~`, or the same folder written in full,
such as `/home/deploy`). sealup sees `/` and `/~` in `sealup.yml` and stops before connecting. It
learns the login folder when it logs in, and stops there, before taking its lock or sending
anything.

The message names the folders the mirror would clean (`/~/api and /~/www` above). When an entry
mirrors the target folder itself (`public_html: .` with `mirror: true`, as in the second message),
it says so: there the mirror reaches whatever else the account holds.

## Why

The mirror deletes every file in the folders it mirrors that is not in your build. In the login
folder of a shared hosting account, that can be mail, backups, other sites and your own
settings. A mistake there is not undone by the next deploy.

Without the mirror, sealup deletes only files it uploaded itself, so a deploy into the login
folder is safe and runs as usual.

## The fix

Deploy into a folder inside it: point the server URL at the web folder (`/~/www`) instead of the
login folder. Or deploy without the mirror: drop `--mirror`, or `mirror: true` from the upload
entry.

If you do mean to mirror it, and every folder the site writes into is excluded, say so on the
target:

```yaml
targets:
  production:
    server: sftp://deploy@ssh.example.com/~
    allow: [root-folder]
```

Run a dry run first (`sealup deploy --dry-run --mirror`): it lists every file the mirror would delete.
