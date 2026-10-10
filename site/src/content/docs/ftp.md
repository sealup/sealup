---
title: FTP
description: Deploy over plain FTP when a host offers nothing else, and what it costs.
---

Plain FTP sends your password and your files unencrypted, and gives no way to check that the
server is yours. sealup deploys over it when a host offers nothing else, and says so on every
run. Where the host offers SFTP or FTPS, use [`sftp://`](/sftp/) or [`ftps://`](/ftps/).

```yaml
server: ftp://deploy@ftp.example.com/~
password: ${SEALUP_PASSWORD}
upload:
  dist: www
```

## The address

`ftp://user@host[:port]/folder`, port 21 unless you write another. sealup uses plain FTP only
when you write `ftp://`: an `ftps://` address never falls back to it. FTP logs in with a
password; there is no host key to save (a `hostKey` is ignored), and `sealup keyscan` says
there is nothing to trust.

## The warning

Every run says it once, in yellow, right after the target block, with the line of `sealup.yml`
to change:

<!-- output: s23-plain-ftp -->
```text
  production  ftp://deploy@ftp.example.com:21/www
  host key    none (plain FTP has no host key)

  ! Plain FTP: your password and files travel unencrypted.
    Most hosts also offer SFTP: write sftp:// in server (sealup.yml line 4).
    It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.

  14 to upload · 9 to delete · 30 unchanged                       2.1 MB

  ✓ Sealed up and delivered: 14 files to production in 3.1 s.
    9 old files removed · https://example.com
```

In GitHub Actions it is also a warning annotation on that line, and a warning box in the job's
summary, so reviewers see it too.

## Connections

FTP sends one file at a time per connection, so sealup opens several: `parallel` is the number
of connections (4 by default, at most 16). Some hosts cap connections per user; lower
`parallel` if yours refuses them. Each file still lands under a hidden temporary name and is
renamed into place, and the second connection FTP opens for each transfer goes only to the host
you named.

## Files written from a secret

A file from `write:` (an `.env`, say) must be private before its first byte arrives. Over FTP,
sealup creates it empty, sets its mode with `SITE CHMOD`, then sends the content. A server that
cannot set modes stops the deploy before any change, with exit 6
([secret-file-public](/e/secret-file-public/)): deploy that file over `sftp://`, or drop the
entry.

## What some FTP servers cannot do

sealup is tested against Pure-FTPd, ProFTPD and vsftpd. Their limits:

- **vsftpd gives file dates to the minute** (to the day for older files): it has no `MLSD`, so
  sealup reads its `LIST`. [`--check-server`](/check-server/) can then miss a file edited on
  the server within that minute if its size did not change, and [`sealup pull`](/pull/) can take
  such a file for the one it already has.
- **ProFTPD** needs `AllowStoreRestart on`, or a server that keeps a file's mode when it is
  written again, for files written from a secret. On a server that stores uploads under a
  hidden name and then renames them (`HiddenStores`), the mode cannot be kept: the deploy stops
  at that file, before any byte of the secret is sent.
- **ProFTPD's listing leaves out a symlink whose target is gone.** sealup never deletes a link
  and never lists below one, so this changes nothing it does.

## The wrong port

An `sftp://` or `ssh://` address whose port answers with FTP stops before anything is sent, and
says so ([wrong-protocol](/e/wrong-protocol/)). Write `ftp://` (or `ftps://`) only if the host
offers no SFTP on another port.

## Learn more

- [FTPS](/ftps/): FTP with TLS, when the host offers it.
- [OVH](/ovh/): OVH offers plain FTP and SFTP, no FTPS.
- [Security](/security/): sealup's known limits.
