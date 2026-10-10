---
title: Files changed on the server
description: Put back files that someone edited or deleted on the server by hand, with --check-server.
---

sealup compares your build with its own list of what it uploaded (kept on the server), not with
the server itself. That is what makes a redeploy fast, but a file someone edited or deleted on
the server by hand stays as it is until your build changes it.

`--check-server` also looks at the server, and puts such files back:

```sh
sealup deploy -n --check-server   # see what was changed by hand
sealup deploy --check-server
```

Or for every deploy to a target:

```yaml
targets:
  production:
    server: sftp://deploy@ssh.example.com/~
    password: ${PROD_PASSWORD}
    checkServer: true
```

## What it checks

sealup lists the server folders that hold files it uploaded (each folder alone, not what is
below it), and uploads again each of its files that:

- is missing;
- has another size than sealup's list says;
- is dated after sealup's list was last written (both dates come from the server's clock).

The dry run, `-v` and the job summary show each one as `changed on the server`:

<!-- output: integration/cli-check-server.test.ts -->
```text
  Would upload 1 file                                               13 B
    ~ robots.txt  changed on the server                             13 B
```

A file you changed locally is uploaded as usual. Files sealup did not upload are not looked at:
for those, see [the full mirror](/mirror/).

## Why it is off by default

Listing a large site takes time, from a second to tens of seconds, on every deploy. A daily
redeploy stays fast without it. Turn it on for a target that people edit by hand, or run it once
after someone did.

Past 200,000 entries or 64 folder levels, the run stops before any change, with exit 6
([listing-too-large](/e/listing-too-large/)).

## Limits

- A file edited on the server keeping the same size and an older date (some tools copy dates)
  is not seen.
- On vsftpd, dates are to the minute: an edit within the minute of the last deploy, with the
  same size, is not seen (see [FTP](/ftp/)).

## Learn more

- [`sealup deploy`](/deploy/): every flag.
- [`sealup.yml`](/config/): `checkServer`.
