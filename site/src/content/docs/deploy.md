---
title: sealup deploy
description: Send the changes in your build to a target.
sidebar:
  label: deploy
---

Send the changes in your build to a target. New and changed files go up. Files that sealup
uploaded before and that are gone from your build are deleted. Everything else on the server is
left alone.

```sh
sealup deploy [target] [flags]
```

## Target

- One target in `sealup.yml`: no name needed.
- Several targets: name one. Without a name, a terminal shows a picker, and CI stops with
  exit 2, listing the names (see [target-not-named](/e/target-not-named/)).

## Flags

| Flag | What it does |
|---|---|
| `--dry-run` | Show every change, change nothing |
| `--mirror` | Also delete server files sealup did not upload (minus excludes). Slower: lists the whole server |
| `--check-server` | Also put back files changed on the server |

Global flags: `-c`, `--env-file`, `--json`, `-v`, `-q`, `--no-color` (see `sealup --help`).

## How a deploy runs

1. sealup reads `sealup.yml` and its variables, and checks the build folder.
2. It connects, checks the server's [host key](/keyscan/) before it sends the password, and
   logs in.
3. It compares the build with its file list on the server (the manifest, in `.sealup/` by
   default), and plans the uploads and deletes.
4. Each file lands under a hidden temp name, then takes its real name: a visitor never gets half
   a file.
5. Deletes run last, once every upload has arrived.

Only changed files travel: a redeploy where nothing changed sends nothing. To tell, sealup
hashes your files (SHA-256) and compares them with its list. On your computer it also keeps a
cache of those hashes, so an unchanged file is not read again: one file per project in
`%LOCALAPPDATA%\sealup` on Windows, `$XDG_CACHE_HOME/sealup` or `~/.cache/sealup` elsewhere.
It holds no secret, and a missing or damaged cache costs only time.

While it runs, a deploy holds a lock on the target, so a second deploy stops before changing
anything ([One deploy at a time](/lock/)). A connection that drops during the transfer is
opened again, up to three times, and only what is left is sent.

## Files changed on the server

By default sealup trusts its file list: a file someone edited on the server by hand stays as it
is until the build changes it. `--check-server` (or `checkServer: true` on the target) also
looks at the server and puts such files back: see
[Files changed on the server](/check-server/).

## The full mirror

By default sealup deletes only files it uploaded itself. `--mirror` (or `mirror: true` on an
upload entry) also deletes every server file that is not in the build, except excluded paths:
see [The full mirror](/mirror/). With the mirror on, a target folder that is the server's root
or the login folder stops the run ([risky-folder](/e/risky-folder/)).

## Safety

There is no confirmation: the dry run is the review step.

sealup stops before changing anything when:

- the build folder is empty or missing ([empty-source](/e/empty-source/)): opt out with
  `allow: [empty-source]` on the target;
- the build holds a symlink, or a folder it writes into on the server is one
  ([symlink](/e/symlink/)): opt out with `allow: [symlinks]` on the target, and links in the
  build are skipped (never followed, listed as skipped) while links on the server are left alone,
  never deleted; a write through a server link still stops the run;
- the mirror is on and the target folder is the server's root or the login folder
  ([risky-folder](/e/risky-folder/)): opt out with `allow: [root-folder]` on the target;
- a file written from a secret would land in a public folder
  ([secret-file-public](/e/secret-file-public/)): opt out with `allowPublic: true` on that
  entry;
- the manifest folder is inside a folder `upload:` sends files to
  ([manifest-inside-target](/e/manifest-inside-target/)).

Each stop is exit 6 (exit 2 for the manifest folder) and leaves the server as it was.

## Examples

```sh
sealup deploy --dry-run          # see what would change
sealup deploy                    # the only target
sealup deploy staging            # one of several targets
sealup deploy production --json  # one JSON object on stdout
```

## Learn more

- [Exit codes](/exit-codes/): did the server change? The exit code says.
- [`sealup.yml`](/config/): `upload`, `exclude`, `write` and the other keys.
