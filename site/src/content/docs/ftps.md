---
title: FTPS
description: Deploy over FTP with TLS, the server's certificate checked like a browser does.
---

FTPS is FTP with TLS: the password and the files are encrypted, and the server proves who it
is with its TLS certificate. Use it where a host offers FTPS but no SFTP.

```yaml
server: ftps://deploy@ftp.example.com/~
password: ${SEALUP_PASSWORD}
upload:
  dist: www
```

## The address

`ftps://user@host[:port]/folder`, port 21 unless you write another. sealup speaks **explicit**
TLS: it connects to that port and asks for TLS (`AUTH TLS`) before anything else. Implicit TLS
(a separate port, usually 990) is not supported.

FTPS logs in with a password: `privateKey` is for `sftp://` and `ssh://`.

## The certificate

By default, sealup checks the certificate as a browser does: a known authority signs it, it is
in date, and it is made for the host in `server`. Then nothing needs saving.

On shared hosting, the certificate is often made for the host's own name rather than the one
you use, or signs itself. Then pin it. `sealup keyscan` shows the certificate without logging
in. On a terminal, once you have compared its SHA-256 with the one your host gives, it saves it
as `tlsFingerprint` on a yes. Without a terminal it never saves, and gives the line to paste:

<!-- output: integration/cli-ftps.test.ts -->
```text
$ sealup keyscan production
  production  ftps://deploy@ftp.example.com:21/www
  host key    certificate CN=sealup test FTP server  not pinned
              SHA-256 4E:2A:…:9C

    subject  CN=sealup test FTP server
    issuer   CN=sealup test FTP server
    valid    2026-10-09 to 2126-09-15
    SHA-256  4E:2A:…:9C

  It is signed by no known authority (self-signed), or it is out of date.
  Nothing was saved: sealup pins a certificate only after a yes on a terminal.
  Compare the SHA-256 with your host's, then paste this line into
  sealup.yml yourself (or run sealup keyscan on a terminal):

  tlsFingerprint: 4E:2A:…:9C
```

With a pin, the server must show exactly that certificate; the authority, name and date
checks are no longer made. When the host renews its certificate, run `sealup keyscan` again
on your computer to compare and replace the pin. See [`sealup keyscan`](/keyscan/).

## Never in clear

- A server that refuses TLS, or will not protect the file transfers, stops the run before your
  user name is sent, with exit 4 ([tls-refused](/e/tls-refused/)). sealup never falls back to
  plain FTP: an `ftps://` address always means encrypted.
- A certificate that fails the check, or differs from the pin, stops the run the same way,
  before the login ([certificate-refused](/e/certificate-refused/)).
- FTP opens a second connection for each transfer. sealup sends it only to the host you named,
  whatever address the server suggests.

## Connections

FTP sends one file at a time per connection, so sealup opens several: `parallel` is the number
of connections (4 by default, at most 16). Some hosts cap connections per user; lower
`parallel` if yours refuses them. The job summary's timing line ends with `FTPS, 4 connections`.

Each file still lands under a hidden temporary name and is renamed into place, and a dropped
connection is opened again, with the certificate checked again first.

## Learn more

- [FTP](/ftp/): plain FTP, and what some FTP servers cannot do.
- [`sealup.yml`](/config/): `tlsFingerprint`, `parallel`.
