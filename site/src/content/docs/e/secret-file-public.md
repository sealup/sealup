---
title: 'A secret file in a public folder'
description: 'A file written from a secret would land in a folder the web server serves.'
---

```text
  ✗ A file written from a secret would land in a public folder: sealup stopped.
    write.www/.env (line 6) writes www/.env,
    inside www/, where visitors could download it.
    Write it outside the web folder. If www/ is not served, add
    allowPublic: true to that entry.

    More: sealup.dev/e/secret-file-public
```

**Exit code:** 6. **Server changed:** no.

## What happened

A `write:` entry writes a file from a secret into a folder whose name looks public: `www`, `public_html`, `public`, `htdocs`, `httpdocs`, `html`, `web` or `wwwroot`. [Files written from a secret](/write/) explains `write:`.

## Why

A web server serves such folders to anyone. A secret written there, such as an `.env` file, could be downloaded.

## The fix

Write the file outside the web folder, where your app reads it. If the folder is not served, add `allowPublic: true` to that entry:

```yaml
write:
  www/.env:
    from: ${APP_ENV}
    allowPublic: true
```

## Over FTP: a server that cannot set file permissions

```text
  ✗ ftp.example.com cannot set file permissions: sealup stopped.
    write.api/.env (line 3) writes /site/api/.env from a secret: it must get
    its file mode before its first byte, and the server refused SITE CHMOD.
    Deploy it over sftp:// instead, or remove that entry.

    Nothing was changed on production.
    More: sealup.dev/e/secret-file-public
```

A file written from a secret gets its mode (`0600` unless the entry says otherwise) before any of its content arrives, so it is never readable by others, not even for a moment. Over FTP that takes `SITE CHMOD`. sealup tries it once after login; when the server refuses it, a deploy with `write:` entries stops there, before any change. Deploy over `sftp://` (most hosts offer it), or remove the `write:` entry and put the file in place another way.
