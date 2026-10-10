---
title: 'A command sealup cannot run'
description: 'A command, flag, value or input that sealup does not take.'
---

```text
  ✗ Unknown flag --dryrun.
    Run sealup --help for the commands and flags that work.

    More: sealup.dev/e/usage
```

**Exit code:** 2. **Server changed:** no.

## What happened

The command line, or an input of the GitHub action, is not one sealup can run: an unknown command or flag, a flag without its value, `-q` with `-v`, too many target names, an unknown help topic, a server address sealup cannot use, or an action input outside what it takes.

## Why

sealup stops on anything it does not understand rather than guess.

## The fix

Read the first line of the error, then `sealup --help`, or `sealup help <command>` for one command. The [command pages](/deploy/) list every flag.
