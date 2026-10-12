---
title: The full mirror
description: Make a server folder match the build exactly, deleting files sealup did not upload.
---

By default sealup deletes only files it uploaded itself, once they leave your build. Anything
else on the server stays: files from before sealup, files the site writes, files someone put
there by hand. The full mirror goes further: it makes a server folder match the build exactly.

## Turn it on

For one upload entry, every deploy:

```yaml
upload:
  public_html:
    to: www
    mirror: true
exclude:
  - public_html/uploads   # users' uploads: never sent, never deleted
```

For every upload entry, one run only, to clean a target once without editing the config:

```sh
sealup deploy --dry-run --mirror   # see every delete first
sealup deploy --mirror
```

## What it deletes

sealup lists the mirrored server folder, all the way down, and deletes every file and every
emptied folder that is not in the build: on a first deploy too, so one run cleans an old site.
Deletes still run last, once every upload has arrived: a failed upload never leaves the site
with files missing.

The dry run lists every delete, each mirror delete marked `not in the build`; a file sealup
uploaded and that left the build is listed apart:

<!-- output: integration/cli-mirror.test.ts -->
```text
  First deploy: files not in your build are deleted (mirror).
  Would delete 2 files  (mirror: sealup did not upload them)
    - old.php  not in the build
    - old/a/b.txt  not in the build
```

## What it never deletes

- **Excluded paths.** List the server folders your site writes into (uploads, caches, logs) in
  `exclude`, on their local side. Nothing below an excluded folder is even listed.
- **sealup's file list and its lock**, which live outside the folders you upload to.
- **Files written from a secret** (`write:`): they are part of what the deploy puts there.
- **Symlinks on the server.** Without `allow: [symlinks]` a link stops the run before any
  change ([symlink](/e/symlink/)); with it, the link is left alone and nothing below it is
  listed.

A `pull:` folder is **not** protected unless an `exclude` covers it. `sealup check` points out
one that is not:

<!-- output: integration/cli-mirror.test.ts -->
```text
  ! The mirror deletes the pull: folder www/resources: no exclude covers it.
    To keep it, add public_html/resources to exclude in sealup.yml.
```

## Limits

Listing takes time on a large site, which is why the mirror is off by default. sealup lists at
most 200,000 entries and 64 folder levels: past that, the run stops before any delete, with
exit 6 ([listing-too-large](/e/listing-too-large/)). Exclude the large server folders (they are
never listed), or drop the mirror.

## Not the whole account

With the mirror on, a target folder that is the server's root (`/`) or the login folder (`/~`)
stops the run before any change, with exit 6 ([risky-folder](/e/risky-folder/)). There, the
mirror could delete whatever else the account holds: mail, other sites, backups.

The check looks at the target folder, even when the mirrored entry goes into a folder inside it,
as `public_html → www` does under a `/~` target. To mirror `www` there, either make `/~/www`
the target folder (with `to: .` and `mirror: true` on the entry), or add
`allow: [root-folder]` to the target once you have checked what the mirror lists: it deletes only
inside the mirrored entries' folders (see [`allow:`](/allow/)).

Without the mirror, a deploy into the login folder runs as usual: it deletes only what it
uploaded.

## Learn more

- [`sealup deploy`](/deploy/): `--mirror` and the other flags.
- [Files changed on the server](/check-server/): put back hand-edited files without deleting
  anything else.
