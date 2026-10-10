---
title: 'sealup.yml is already here'
description: 'sealup init never overwrites an existing sealup.yml.'
---

```text
  ✗ sealup.yml is already here: sealup init never overwrites it.
    This project is set up. Its targets and commands:  sealup
    To start again, move sealup.yml away first.

    More: sealup.dev/e/config-exists
```

**Exit code:** 2. **Server changed:** no: nothing was written.

## What happened

`sealup init` found a `sealup.yml` in this folder.

## Why

`init` never overwrites a config: yours may hold work you want to keep.

## The fix

The project is set up: run `sealup` alone to see its targets and commands. To start again, move `sealup.yml` away first, then run `sealup init`.
