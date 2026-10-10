---
title: sealup check
description: Check sealup.yml and its variables without touching the server.
sidebar:
  label: check
---

Check `sealup.yml` and its variables without touching the server: the file, the targets, the
upload folders, the variables (their names and where they come from, never their values) and the
host keys. The safety nets that need no server run too.

```sh
sealup check [target] [flags]
```

## Target

- No name: every target. A problem of one target is a warning for it, and the exit code is 0
  when at least one target is ready.
- A name: that target only.

## Warnings

A `pull:` folder inside a folder that an upload entry mirrors (`mirror: true`) is deleted by every
deploy, unless an `exclude` covers it. `check` prints a yellow line for each such folder, with the
path to add to `exclude`, and does not change the exit code:

<!-- output: integration/cli-mirror.test.ts -->
```text
  ! The mirror deletes the pull: folder www/resources: no exclude covers it.
    To keep it, add public_html/resources to exclude in sealup.yml.
```

## Exit code

What a deploy would give before connecting:

| Code | Meaning |
|---|---|
| 0 | Ready |
| 2 | A config or variable problem |
| 4 | No host key |
| 6 | A safety net |

Global flags: `-c`, `--env-file`, `--json`, `-q`, `--no-color` (see `sealup --help`).

## Examples

```sh
sealup check                     # every target
sealup check staging             # one target
sealup check --json              # one JSON object on stdout
```

## Learn more

- [`sealup deploy -n`](/deploy/): a dry run also checks the server.
- [Exit codes](/exit-codes/): every code sealup gives.
