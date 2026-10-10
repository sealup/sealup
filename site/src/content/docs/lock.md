---
title: One deploy at a time
description: The lock that keeps two sealup runs from deploying to the same target at once.
---

Two deploys to the same server folder at the same moment (two quick pushes, or a laptop and CI)
would mix their uploads and deletes, and the last one to write sealup's file list would win. So
each deploy takes a lock on the target first, and a second one stops before changing anything.

## How it works

Right after logging in, sealup makes the lock: a folder next to its file list (in `.sealup/` in
the login folder by default), named after the list with `.lock` at the end. Making a folder is
atomic on every protocol, so only one run can make it. Inside, a small note says which run
holds it: its id, its machine, when it started and, in GitHub Actions, the run's page.

While it sends files, the run rewrites the note every 30 seconds. When it ends, whether it
succeeded, failed or was stopped with Ctrl-C, it removes the lock.

## When another run holds it

The deploy stops before reading the file list or sending anything, with exit 6:

<!-- output: integration/lock.test.ts -->
```text
  ✗ Another run is deploying to production: sealup stopped.
    Run 7f3a9c21d04e5b68 on build-box has held it since 2026-10-09 08:15 UTC.
    Let it finish, then deploy again. A lock whose run died is taken over
    once its note is 10 minutes old.

    Nothing was changed on production.
    More: sealup.dev/e/lock-held
```

In a script, exit 6 means "nothing changed, fix the cause first", as for the other safety nets
(see [Exit codes](/exit-codes/) and [lock-held](/e/lock-held/)).

## When the run that held it died

A laptop closed or a CI job killed leaves the lock behind. You don't need to remove it: once its
note is 10 minutes old by the server's clock (not your machine's), the next deploy takes it over
and says whose it was:

<!-- output: integration/lock.test.ts -->
```text
  ! Took over the lock of a run that stopped answering 25 min ago:
    run 7f3a9c21d04e5b68 on build-box, started 2026-10-09 08:15 UTC.
```

A lock with no note is taken over the same way. Two runs that find the same dead lock never both
take it: one deploys, the other stops.

## Dry runs and pulls

A dry run never takes the lock. When another run holds it, the dry run says so and still shows
its plan, with exit 0, so a preview never fails a check or blocks a real deploy:

<!-- output: integration/lock.test.ts -->
```text
  ! Another run is deploying to production: a deploy now would stop.
    Run 7f3a9c21d04e5b68 on build-box, started 2026-10-09 08:15 UTC.

  Would upload 1 file                                                2 B
    ~ index.html                                                     2 B
```

`sealup pull` only reads the server, and takes no lock.

## In GitHub Actions

The workflow `sealup init` writes has a `concurrency` group, so GitHub queues a second deploy
of that workflow until the first one ends, before sealup has to refuse it. The lock still
covers what GitHub cannot see: a deploy from a laptop, or from another workflow.

## Learn more

- [lock-held](/e/lock-held/): what to do with a lock sealup cannot read.
- [The GitHub Action](/github-action/): the workflow and its `concurrency` group.
