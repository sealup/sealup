---
title: 'TLS certificate refused'
description: 'An ftps:// server showed a certificate sealup does not trust, so it stopped before logging in.'
---

```text
  ✗ The server's TLS certificate is not trusted. sealup stopped before logging in.
    The TLS certificate is signed by no known authority, or is out of date.
      subject  CN=ftp.example.com
      issuer   CN=ftp.example.com
      valid    2026-01-01 to 2027-01-01
      SHA-256  71:CA:A9:…:C8:59
    If your host confirms this certificate (ask for its SHA-256), pin it:
      sealup keyscan production   then commit sealup.yml.

    The password was not sent. Nothing was changed on production.
    More: sealup.dev/e/certificate-refused
```

**Exit code:** 4. **Server changed:** no: the user name and password were not sent.

## What happened

Over `ftps://`, sealup checks the server's TLS certificate before it sends anything about you, as a browser does. One of these failed:

- **not trusted:** no certificate authority known to Node signs it (a self-signed certificate), or it is out of date;
- **names another host:** a trusted certificate, but for another name than the one in `server`;
- **changed:** `tlsFingerprint` pins one certificate, and the server showed another.

## Why

Shared hosts often serve FTPS with a certificate made for their own name (`*.host.example`), not for the name in your `server` line. Or the host renewed its certificate. Or someone between you and the server is posing as it: that is what the check is for.

## The fix

Ask your host for the certificate's SHA-256 fingerprint. If it matches the one sealup shows, pin it on your own machine and commit `sealup.yml`:

```sh
sealup keyscan production
```

`keyscan` shows the certificate's subject, issuer, dates and SHA-256, and offers to save it as `tlsFingerprint` only when the normal check fails. With a pin, the certificate must be that one: the CA and host name checks are no longer made. When the host renews the certificate, the pin must be updated the same way.

If the fingerprint is not your host's, do not deploy: tell your host.

When `sealup.yml` reads the pin from a variable (`tlsFingerprint: ${SEALUP_TLS_FINGERPRINT}`, a public repository), there is nothing to commit: `keyscan` prints the new SHA-256, and you set the variable in `sealup.env` and in CI. See [The key is read from a variable](/e/key-in-variable/). In GitHub's log, the received SHA-256 of such a target shows as `***`.
