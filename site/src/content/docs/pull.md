---
title: sealup pull
description: Copy server files, such as users' uploads, to this machine.
sidebar:
  label: pull
---

Copy server files (the users' uploads) to this machine. New files come down, and a local file of
another size or date is replaced by the server's copy. Local files are never deleted, and nothing
is written outside the folder of `sealup.yml`.

```sh
sealup pull [target] [flags]
```

The folders to copy are the [`pull:`](/config/#pull) entries of `sealup.yml`, server folder on
the left, local folder on the right:

```yaml
pull:
  www/resources: public_html/resources
```

## Target

- One target in `sealup.yml`: no name needed.
- Several targets: name one. Without a name, a terminal shows a picker.

## Flags

| Flag | What it does |
|---|---|
| `--dry-run` | List every file to download, change nothing |

Global flags: `-c`, `--env-file`, `--json`, `-v`, `-q`, `--no-color` (see `sealup --help`).

## Safety

- On your own machine only: without a terminal (CI) it stops with exit 2
  ([pull-in-ci](/e/pull-in-ci/)).
- It stops before writing anything on a server name that Windows or a path cannot hold
  ([pull-unsafe-name](/e/pull-unsafe-name/)), a link or junction on the local path
  ([pull-local-path](/e/pull-local-path/)), or a listing too large
  ([pull-too-large](/e/pull-too-large/)).
- Links on the server are skipped, never followed.
- A pull never changes the server.

## Examples

```sh
sealup pull --dry-run            # see what would come down
sealup pull production           # one of several targets
```

## Learn more

- [`sealup.yml`](/config/#pull): the `pull:` key.
