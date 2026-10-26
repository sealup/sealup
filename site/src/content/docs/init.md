---
title: sealup init
description: Set up a project for sealup, writing sealup.yml, sealup.env and a GitHub workflow.
sidebar:
  label: init
---

Set up this project. `sealup init` finds the build folder and the build command, asks for the
server address, checks the server's key, keeps the password in `sealup.env` (git-ignored), and
writes `sealup.yml` and a GitHub workflow.

```sh
sealup init [flags]
```

## On a terminal

It asks for the server address, then shows the server's host key and saves it on a yes. It
asks whether the repository is public (no by default), and for the password last, without
showing what you type. The password goes to `sealup.env`, never to `sealup.yml`.

On "public", the server and the host key go to `sealup.env` too: `sealup.yml` reads them as
`${SEALUP_SERVER}` and `${SEALUP_HOST_KEY}`, the workflow passes them from secrets, and the last
screen names each secret to add (see [A public repository](/security/#a-public-repository)).

## Without a terminal

`--server` is needed: with no terminal there is no one to ask (see
[no-terminal](/e/no-terminal/)). `sealup.yml` gets a placeholder for the host key: run
[`sealup keyscan`](/keyscan/) on your own computer to fill it in. No `sealup.env` is written.

## Flags

| Flag | What it does |
|---|---|
| `--server <url>` | The server address, `sftp://user@host[:port]/folder`, or `ssh://`, `ftps://`, `ftp://` |
| `--from <file>` | Convert a sam-sync deployment config; review every mapping and reported omission before deploying |

Global flags: `--json`, `--no-color` (see `sealup --help`).

## Never overwrites

- An existing `sealup.yml` stops it with exit 2, and nothing is written (see
  [config-exists](/e/config-exists/)).
- An existing workflow is left as it is.
- An existing `sealup.env` only gets the variables it lacks (`SEALUP_PASSWORD`, and for a
  public repository `SEALUP_SERVER` and `SEALUP_HOST_KEY`).

## Examples

```sh
sealup init
sealup init --server sftp://deploy@ssh.example.com/home/site/www
```

## Learn more

- [`sealup.yml`](/config/): the keys it writes.
- [`sealup keyscan`](/keyscan/): how the host key is checked.
- [Migrating from sam-sync](/migrate-sam-sync/): current local env files and shared targets.
