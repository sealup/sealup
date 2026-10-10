---
title: 'sealup pull in CI'
description: 'sealup pull runs on your own machine only.'
---

```text
  ✗ sealup pull does not run in CI.
    It copies server files to the machine it runs on, and a CI runner is
    thrown away when the job ends, so the files would go with it.
    Run it on your own machine:  sealup pull production

    More: sealup.dev/e/pull-in-ci
```

**Exit code:** 2. **Server changed:** no: nothing was downloaded.

## What happened

`sealup pull` ran without a terminal, as in CI.

## Why

It copies server files to the machine it runs on. A CI runner is thrown away when the job ends, and the files with it.

## The fix

Run [`sealup pull`](/pull/) on your own machine.
