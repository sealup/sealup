---
title: Deploy to OVH
description: Deploy a site to OVHcloud web hosting from GitHub Actions, over SFTP, SSH or FTP.
---

This tutorial deploys a built site to OVHcloud web hosting, first from your computer, then on
every push from GitHub Actions. It follows [Getting started](/getting-started/) with OVH's
names. sealup is tested on a real OVH account before each release, over SFTP, SSH and FTP.

The output below comes from sealup's own tests, with `example.com` names: your login, your
cluster and your files will show instead.

## What OVH gives you

Every OVH web hosting plan comes with one main login, for FTP, SFTP and (on some plans) SSH.
In the OVHcloud Control Panel, open your hosting plan and its **FTP-SSH** tab. It shows:

- the **login**;
- the **server addresses**: one for FTP (`ftp.clusterXXX.hosting.ovh.net`) and one for SFTP
  and SSH (`ssh.clusterXXX.hosting.ovh.net`), where `clusterXXX` is your plan's cluster;
- the login's **home folder**, where you land when you log in. In it, `www/` is the folder
  your main domain serves (its root folder, which the **Multisite** tab can change).

Use the password of that login. If you don't know it, the same tab can change it.

## Choose the protocol

| Your plan offers | Write | Why |
|---|---|---|
| SFTP (every plan; on the entry plans, switch it on for the login) | `sftp://` | Encrypted, and the server's key is checked |
| SSH (the higher plans) | `ssh://` | SFTP, plus one `tar` archive for the uploads: the fastest first deploy |
| Only FTP | `ftp://` | Works, but the password travels in clear: sealup warns on every run |

OVH does not offer FTPS: an `ftps://` address stops with exit 4 before your login is sent
([tls-refused](/e/tls-refused/)). Prefer SFTP: on the entry plans, the **FTP-SSH** tab has a
switch to turn it on for your login.

## 1. Set up the project

In your project folder, run `sealup init`:

```sh
npx sealup init
```

When it asks for the server address, give the SFTP address with your login and the home
folder, `/~`: `sftp://LOGIN@ssh.clusterXXX.hosting.ovh.net/~`.

`init` then shows the server's key. Compare its fingerprint with the one OVH gives for your
cluster before you answer `y`; if you cannot find it, ask OVH's support first. The key goes into
`sealup.yml`, and from then on every deploy checks it before it sends your password. Then
`init` asks for the password, keeps it in `sealup.env` (git-ignored), and writes the GitHub
workflow.

## 2. Send the build into www

`init` wrote `upload: dist`, which would put your build in the home folder itself, where
sealup keeps its own file list: `sealup check` refuses it
([manifest-inside-target](/e/manifest-inside-target/)). Say which folder goes where instead. A
built front end goes into `www`:

```yaml
server: sftp://LOGIN@ssh.clusterXXX.hosting.ovh.net/~
password: ${SEALUP_PASSWORD}
hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86
url: https://example.com

upload:
  dist: www
```

A PHP project, with a public folder and an API beside it, sends each folder to its own place.
Files that the site writes on the server (users' uploads, logs) are excluded: never sent, never
deleted:

```yaml
upload:
  public_html: www
  api: api
  .ovhconfig: .ovhconfig   # one file into the home folder: OVH's PHP settings
exclude:
  - public_html/uploads
  - api/storage
```

sealup keeps its list of uploaded files in `.sealup/` in the home folder, next to `www/`, where
no visitor can reach it. Everything else in the home folder stays as it is: sealup only ever
deletes files it uploaded.

Run `sealup check` to read the file and its variables without connecting.

## 3. Deploy from your computer

Look at the dry run, then deploy:

```sh
npx sealup deploy -n
npx sealup deploy
```

<!-- output: s07-first-deploy -->
```text
  production  sftp://deploy@ssh.example.com:22/home/site
  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified

  First deploy: existing files stay. sealup only ever deletes files it uploaded.
  1,200 to upload                                                 1.2 MB

  ✓ Sealed up and delivered: 1,200 files to production in 15.6 s.
    https://example.com
```

The next deploys send only what changed. Files that were in `www/` before stay until you
remove them: sealup did not upload them.

## 4. Deploy from GitHub Actions

1. In the GitHub repository, open **Settings › Secrets and variables › Actions** and add the
   secret `SEALUP_PASSWORD` with your OVH password.
2. Commit `sealup.yml` and `.github/workflows/deploy.yml` (never `sealup.env`), and push to
   `main`.

OVH has no IP allow-list for FTP or SSH, so GitHub's runners connect as your computer does. See
[the GitHub Action](/github-action/) for the step and its options.

## SSH on the higher plans

With SSH, write `ssh://` instead of `sftp://`, with the same address and key:

```yaml
server: ssh://LOGIN@ssh.clusterXXX.hosting.ovh.net/~
```

Changed files then travel as one compressed archive, unpacked by `tar` on the server, and take
their real names at the end: a first deploy is several times faster than file by file. Deletes, the file list and the lock still go over SFTP. See [SSH](/ssh/).

## Plain FTP

On a login with FTP only, write `ftp://` with the FTP address. There is no host key to save:

```yaml
server: ftp://LOGIN@ftp.clusterXXX.hosting.ovh.net/~
password: ${SEALUP_PASSWORD}
```

The deploy works, and every run says what it costs:

<!-- output: s23-plain-ftp -->
```text
  production  ftp://deploy@ftp.example.com:21/www
  host key    none (plain FTP has no host key)

  ! Plain FTP: your password and files travel unencrypted.
    Most hosts also offer SFTP: write sftp:// in server (sealup.yml line 4).
    It is faster too: a first deploy took 15.6 s over SFTP, 225 s over FTP.
```

Switch SFTP on for the login when you can, and change the address. See [FTP](/ftp/).

## Several sites on one plan

The **Multisite** tab says which folder each domain serves. Send each build to its folder, or
give each site its own target under `targets:` (see [`sealup.yml`](/config/)):

```yaml
upload:
  dist: www
  admin/dist: admin
```

## Next

- [`sealup deploy`](/deploy/): every flag, and what stops a deploy before it changes anything.
- [`sealup pull`](/pull/): bring users' uploads back from the server.
- [Private keys](/private-keys/): log in with a key where your plan takes one.
