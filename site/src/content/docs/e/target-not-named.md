---
title: 'Which target?'
description: 'sealup.yml has several targets and the command named none.'
---

```text
  ✗ Which target? sealup.yml has 2 and none was named.
    In CI sealup never asks. Name the target in the command:
      sealup deploy staging
      sealup deploy production

    More: sealup.dev/e/target-not-named
```

**Exit code:** 2. **Server changed:** no.

## What happened

`sealup.yml` has several targets under `targets:`, and the command did not name one.

## Why

On a terminal sealup shows a picker. In CI, or when its input is piped, there is no one to ask, and sealup never guesses where to deploy.

## The fix

Name the target after the command:

```sh
sealup deploy production
```

With the GitHub action, set its `target` input:

```yaml
- uses: sealup/sealup@…
  with:
    target: production
```
