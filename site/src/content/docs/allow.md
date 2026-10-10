---
title: Turning off a safety net
description: "allow: turns off one of sealup's safety nets for a target, on purpose."
---

sealup stops before changing anything when a deploy looks dangerous. Each stop is exit 6, with
its own page, and leaves the server as it was. When the danger is what you want, say so in
`sealup.yml`, for one target:

```yaml
targets:
  production:
    server: sftp://deploy@ssh.example.com/~
    password: ${PROD_PASSWORD}
    allow: [symlinks]
```

| Value | Turns off the stop on | Page |
|---|---|---|
| `empty-source` | an empty or missing build folder | [empty-source](/e/empty-source/) |
| `symlinks` | a symlink in the build, or on the server | [symlink](/e/symlink/) |
| `root-folder` | the mirror into the server's root or the login folder | [risky-folder](/e/risky-folder/) |

`allow:` goes on a target, never at the top level: each target's risks are its own.

## `empty-source`

An empty build folder would delete every file sealup uploaded there: most likely the build
failed. With `allow: [empty-source]`, an empty folder deploys as an empty folder.

## `symlinks`

sealup never follows a symlink: a link could pull files from outside your build, or make it
write outside the target folder. Without the allow, a link in the build, or a server folder it
writes into that is a link, stops the run. With it:

- links in your build are skipped, never followed, and listed:

<!-- output: integration/allow-symlinks.test.ts -->
```text
  Would skip 1 link in your build  (sealup never follows a link)
    · public_html/storage
```

- links on the server are left alone and never deleted (the dry run says
  `a link on the server, never deleted`);
- a write **through** a server link still stops the run, whatever `allow:` says.

This is what a Laravel site needs for its `public/storage` link to `storage/app/public`: the
link stays on the server, and sealup leaves it alone.

## `root-folder`

With [the full mirror](/mirror/) on, a target folder that is the server's root (`/`) or the
login folder (`/~`) stops the run: the mirror could delete whatever else the account holds.
`allow: [root-folder]` lets it run. Without the mirror, a deploy into the login folder needs no
allow.

## Files written from a secret

A file from `write:` (an `.env`, say) that would land in a folder whose name looks served
(`www`, `public_html`, `public`, `htdocs`, …) stops the run: visitors could download it. That
one is not turned off by `allow:` but on the entry itself, once you know the folder is not
served:

```yaml
write:
  www/config/.env:
    from: ${APP_ENV}
    allowPublic: true
```

See [secret-file-public](/e/secret-file-public/).

## Learn more

- [`sealup deploy`](/deploy/): every stop, under Safety.
- [`sealup.yml`](/config/): `allow`, `write`.
