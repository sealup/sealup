---
title: 'Cancelled'
description: 'A question of sealup was left without an answer.'
---

```text
  ✗ Stopped: no target was chosen.

    More: sealup.dev/e/cancelled
```

**Exit code:** 130. **Server changed:** no.

## What happened

sealup asked a question, the target picker or a yes or no, and it was closed without an answer (Esc, Ctrl-C or the end of the input).

## Why

sealup does nothing it was not told to do.

## The fix

Run the command again and answer, or name the target in the command: `sealup deploy production`.
