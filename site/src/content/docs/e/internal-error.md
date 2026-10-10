---
title: 'An error sealup did not expect'
description: 'sealup stopped on an error it has no words for: a bug.'
---

```text
  ✗ sealup stopped on an error it did not expect.
    Run the same command with --debug to see where, and report it.

    More: sealup.dev/e/internal-error
```

**Exit code:** 1. **Server changed:** the last line says.

## What happened

Something went wrong that sealup has no plain explanation for. It is a bug in sealup, not in your setup.

## Why

Every error sealup knows has its own words and page. This one does not.

## The fix

Run the same command with `--debug`: it shows where the error happened. Report it on [GitHub](https://github.com/sealup/sealup/issues) with that output, after removing anything private. The last line of the error says whether the server changed; running the same command again is safe, and sends only what is missing.
