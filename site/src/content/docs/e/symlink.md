---
title: 'A symlink in the build or on the server'
description: 'A symbolic link sealup will not go through, in the build or on the server, so sealup stopped before any change.'
---

In the build:

```text
  ✗ dist/media is a symlink: sealup stopped before connecting.
    sealup does not follow links: one could send files from outside the project.
    Put the real file or folder there, or exclude the link.

    More: sealup.dev/e/symlink
```

On the server:

```text
  ✗ /home/deploy/www/api is a symlink on the server: sealup stopped.
    sealup never writes through a link: files could land outside the target.
    Replace the link with a real folder, or exclude what goes into it.

    Nothing was changed on production.
    More: sealup.dev/e/symlink
```

**Exit code:** 6. **Server changed:** no.

## What happened

In the build: a file or folder to upload is a symbolic link.

On the server: a folder the deploy would write or delete in, inside the target folder, is a symbolic link. sealup looks at each such folder once per run, after login and before changing anything. A folder it makes in this run is not looked at.

## Why

Following a link in the build could send files from outside the project, such as a home folder or a secrets file. sealup follows none.

On the server, a link inside the target folder could make an upload or a delete land outside it: a link planted through a web application, for example. sealup writes and deletes only in real folders. When it deletes a link, it removes the link itself, never what it points to.

## The fix

In the build: put the real file or folder there, or leave the link out with `exclude:` in `sealup.yml`.

On the server: if you did not make the link, remove it and check how it got there. If it is yours, replace it with a real folder, or exclude the files the build puts into it.

A link you keep on purpose, such as Laravel's `public/storage`: add `allow: [symlinks]` to the target.

```yaml
targets:
  production:
    server: sftp://deploy@ssh.example.com/~/www
    allow: [symlinks]
```

Then links in the build are skipped, never followed: the dry run, the output and the job summary list them as skipped. Links on the server inside the target folder are left alone and never deleted: a file sealup uploaded that is now a link, or behind one, is kept. A write through a link on the server still stops the run, with or without `allow:`.
