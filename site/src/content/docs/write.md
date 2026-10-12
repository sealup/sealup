---
title: Files written from a secret
description: "write: puts a file such as your production .env on the server from one secret, on each deploy."
---

Your API needs a `.env` on the server, with its database password and its keys. That file must
not be in git, and it is not in your build. `write:` puts it there on each deploy, from one
secret:

```yaml
upload:
  dist: www
  api: api
write:
  api/.env: ${API_ENV}   # the whole .env, from the API_ENV secret
```

The left side is where the file goes on the server, inside the target folder. The right side is
one variable, and its value is the file's whole content, every line of it.

## Where the content comes from

One variable holds the whole file, line breaks included.

- **In GitHub Actions:** add a secret named `API_ENV` and paste the whole `.env` into it, as it
  is. Pass it to the sealup step, beside the password:

  ```yaml
  env:
    SEALUP_PASSWORD: ${{ secrets.SEALUP_PASSWORD }}
    API_ENV: ${{ secrets.API_ENV }}
  ```

- **On your machine:** put it in `sealup.env` (git-ignored), in double quotes, each line break
  written `\n`:

  ```ini
  API_ENV="APP_ENV=production\nDB_PASSWORD=change-me"
  ```

`sealup check` says whether every variable is set, without connecting. A deploy with the
variable unset stops before connecting ([variable-not-set](/e/variable-not-set/)).

The value in `sealup.yml` is always one `${NAME}`: sealup stops on a file's content written in
the file itself, so it never reaches git ([config-invalid](/e/config-invalid/)).

## What a deploy does with it

- **Never on disk.** sealup builds the file in memory and sends it. It never writes it to a local
  file: not in a temp folder, not in its cache.
- **Private from its first byte.** The file gets mode `0600` (only the account that owns it can
  read it) before any of its content arrives. It goes up under a hidden temp name, then is
  renamed into place, after the uploads: never half-written.
- **Written on each deploy, when it differs.** sealup reads the server's copy first. When it holds
  the same content with the same mode, nothing is sent and it counts as unchanged. When the
  secret changed, someone edited the file, or its mode is another, it is written again.
- **Never in the log.** The dry run lists the file and its variable, never its content or size:
  `+ api/.env  from API_ENV`. In GitHub's log, the whole value and each of its lines (from 6
  characters) are masked.

The long form takes another mode, when the user your site runs as reads the file through its
group:

```yaml
write:
  api/.env:
    from: ${API_ENV}
    mode: '0640'
```

## What it never does

- **It never deletes the file.** It is not in sealup's file list of what it uploaded. Remove the
  entry, and sealup leaves the file where it is and forgets it; delete it by hand if you want it
  gone. A path an old deploy uploaded, and that a `write:` entry now writes, is not deleted
  either.
- **It never writes into a folder that looks public.** A file under `www`, `public_html`,
  `public`, `htdocs`, `httpdocs`, `html`, `web` or `wwwroot` could be downloaded by anyone: the
  deploy stops before connecting, with exit 6. If that folder is not served, add
  `allowPublic: true` to the entry ([secret-file-public](/e/secret-file-public/)).
- **It never shares a path with an upload.** An upload that sends the same server path, or two
  `write:` entries on one path, stop the run with exit 2
  ([same-server-path](/e/same-server-path/)).

Over FTP, the mode is set with `SITE CHMOD`; a server that refuses it stops a deploy with
`write:` entries before any change. See [FTP](/ftp/#files-written-from-a-secret).

## With `mirror:`

The [full mirror](/mirror/) never deletes a file written from a secret, nor the folder that holds
it: the mirror counts it as part of the build.

## With `pull:`

[`sealup pull`](/pull/) does not know about `write:`. A `pull:` entry whose server folder holds the
written file copies it to your machine like any other file, and from there it is on your disk.
Point `pull:` at the folders your site writes into (users' uploads), not at the folder that holds
the `.env`:

```yaml
write:
  api/.env: ${API_ENV}
pull:
  www/uploads: uploads   # not api: that would bring api/.env down
```

## Several targets

`write:` at the top level is written to every target; a target's own `write:` adds its files.
Give each target its own variable when the content differs:

```yaml
targets:
  staging:
    server: sftp://deploy@ssh.example.com/home/site/staging
    password: ${STAGING_PASSWORD}
    write:
      api/.env: ${STAGING_API_ENV}
  production:
    server: sftp://deploy@ssh.example.com/home/site/production
    password: ${PRODUCTION_PASSWORD}
    write:
      api/.env: ${PRODUCTION_API_ENV}
```

## Learn more

- [`sealup.yml`](/config/#write): the `write` key and its long form.
- [Security](/security/): what sealup does with your secrets.
