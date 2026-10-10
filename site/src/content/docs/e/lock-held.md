---
title: 'Another run is deploying'
description: 'Another sealup run holds the lock of this target folder, so this one stopped before changing anything.'
---

```text
  ✗ Another run is deploying to production: sealup stopped.
    Run 7f3a9c21d04e5b68 on build-box has held it since 2026-10-09 08:15 UTC.
    CI run: https://github.com/acme/site/actions/runs/42
    Let it finish, then deploy again. A lock whose run died is taken over
    once its note is 10 minutes old.

    Nothing was changed on production.
    More: sealup.dev/e/lock-held
```

**Exit code:** 6. **Server changed:** no.

## What happened

Right after logging in, sealup takes a lock on the target folder, so that only one run at a time deploys there. Another run already held it: a CI job, a deploy from another laptop, or one you started a minute ago. sealup stopped before reading its file list or sending anything.

The lock is a folder next to sealup's file list (in `.sealup/` in the login folder by default), named after it with `.lock` at the end. It holds a small note: the run's id, its machine, when it started and, in CI, the run's page. The run that holds it rewrites the note every 30 seconds while it sends files, and removes the lock when it ends, whether it succeeded, failed or was stopped with Ctrl-C.

## Why

Two runs at once would mix their uploads and deletes, and the last one to write the file list would win: the next deploy would trust a list that is wrong.

## The fix

Let the other run finish, then deploy again. In GitHub Actions, the workflow `sealup init` writes has a `concurrency` group, so GitHub queues a second run of that workflow before sealup has to refuse it.

If the run that held the lock died (a laptop closed, a CI job killed), you do not need to do anything: once its note is 10 minutes old, the next deploy takes the lock over and prints a warning that names the old run. The age is the server's own clock, so a machine whose clock is wrong judges it the same. A lock with no note at all (its run stopped right after making it) is taken over the same way, once the server has seen nothing of it for 10 minutes. When two runs find the same dead lock, one takes it over and the other stops.

If the message says the lock has no note sealup can read, it names the lock folder. When you are sure no run is deploying, remove that folder on the server, then deploy again.

A dry run (`sealup deploy -n`) never takes the lock: it shows a warning and its plan. `sealup pull` only reads the server and takes no lock.
