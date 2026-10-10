---
title: Getting started
description: From nothing to a deploy from GitHub Actions, step by step.
---

This page takes a project from nothing to a deploy on every push, from GitHub Actions. It takes
about ten minutes. On OVH, the [OVH tutorial](/ovh/) gives the same steps with OVH's names.

The output below comes from sealup's own tests, with `example.com` names: your server, your
files and your timings will show instead.

## What you need

- **Node.js 24 or later** on your computer. In GitHub Actions, the action needs nothing
  installed.
- **A build folder**: the files your site serves, such as `dist/` after `npm run build`, or a
  plain folder of HTML and PHP.
- **Your server's address and login**, from your host's control panel: the protocol (SFTP if
  the host offers it), the user name, the host name, and the password or a [private
  key](/private-keys/).
- **A GitHub repository** for the project, if you want deploys from GitHub Actions.

## 1. Set up the project

In your project folder, run `sealup init`. It finds the build folder and the build command,
asks for the server's address, shows the server's key, and asks for the password:

```sh
npx sealup init
```

<!-- output: s02-init -->
```text
  Upload folder   dist/  (found, 3 files)
  Build           npm run build  (from package.json, for the GitHub workflow)

  Where should it go? A URL like sftp://user@host/folder
  (also ssh://, ftps://, or ftp:// for plain FTP)
  Server address: sftp://deploy@ssh.example.com/home/site/www

  ssh.example.com  sftp://deploy@ssh.example.com:22/home/site/www
  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  not saved

  This is the server's ED25519 key. Compare the fingerprint with the one in
  your host's control panel (SSH settings), or ask their support.
  If they match, this is your server.
  Save it to sealup.yml as hostKey? [y/N] y

  The password goes in sealup.env, which stays on this machine (git-ignored).
  Password for deploy@ssh.example.com: ••••••••

  ✓ This project is set up. Files written:
    + sealup.yml                     server, password, hostKey, upload: dist
    + sealup.env                     SEALUP_PASSWORD (git-ignored)
    ~ .gitignore                     added the line sealup.env
    + .github/workflows/deploy.yml   on push to main: build, then deploy

  On GitHub, add the secret SEALUP_PASSWORD with the same password:
  Settings › Secrets and variables › Actions › New repository secret

  Next:
    sealup deploy -n    dry run: list every change, change nothing
    sealup deploy       deploy to ssh.example.com
```

The address says the protocol, the user, the host and the folder: `sftp://`, `ssh://`,
`ftps://` or `ftp://` (see [SFTP](/sftp/), [SSH](/ssh/), [FTPS](/ftps/), [FTP](/ftp/)). A
folder that starts with `/~` is in the folder you land in when you log in (the login folder):
`/~` is that folder itself.

Compare the fingerprint before you answer `y`. The host key is how sealup knows, on every
deploy, that it talks to your server and not to someone posing as it (see
[`sealup keyscan`](/keyscan/)).

## 2. Say where each folder goes

`init` wrote `upload: dist`: the build goes into the folder of `server`. On most shared
hosting, though, the login folder holds the folder the site is served from (often `www/` or
`public_html/`), next to things that are not public. There, point `server` at the login folder
and say which local folder goes into which server folder under `upload`:

```yaml
server: sftp://deploy@ssh.example.com/~
password: ${SEALUP_PASSWORD}
hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86
url: https://example.com

upload:
  dist: www          # local folder: server folder, from the login folder
```

This is the shape the rest of these pages use. A project with an API next to the site adds a
line per folder (`api: api`). sealup keeps its list of what it uploaded in `.sealup/` in the
login folder, outside the folders visitors reach.

`password` holds a variable, never the password itself: `sealup.yml` is meant to be committed.
On your computer the value comes from `sealup.env`, which `init` added to `.gitignore`; in CI
it comes from a secret. Every key is on the [`sealup.yml`](/config/) page.

To check the file and its variables without connecting, run `sealup check`.

## 3. Deploy from your computer

A dry run shows every change and changes nothing:

```sh
npx sealup deploy -n
```

Then deploy:

```sh
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

sealup checked the host key before it sent the password. Each file arrived under a hidden
temporary name and then took its real name, so a visitor never got half a file. Files already
on the server stay: sealup only ever deletes files it uploaded.

## 4. Change something, deploy again

Build again, then look at the dry run. It lists what would go up, what would be deleted (only
files sealup uploaded that left your build), and what stays:

<!-- output: s10-dry-run -->
```text
$ sealup deploy -n
  DRY RUN  nothing will change on production
  production  sftp://deploy@ssh.example.com:22/home/site
  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified

  Would upload 4 files                                            424 KB
    + www/admin/main.1b7e9f30.js                                    3 KB
    + www/main.4f2a9c1e.js                                        412 KB
    ~ api/routes/api.php                                            5 KB
    ~ www/index.html                                                4 KB
  Would delete 2 files  (sealup uploaded them; they are no longer in your build)
    - www/admin/main.93c5b8e0.js
    - www/main.8b1e3d07.js
  Would keep 1 file
    · www/robots.txt  excluded now, never deleted
  1,001 unchanged

  DRY RUN  nothing was changed. To apply: sealup deploy production
```

Only changed files travel. A deploy where nothing changed sends nothing:

<!-- output: s09-nothing-changed -->
```text
$ sealup deploy
  production  sftp://deploy@ssh.example.com:22/home/site
  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified

  ✓ Already up to date: 1,001 files checked on production in 3.0 s.
    https://example.com
```

## 5. Deploy from GitHub Actions

`sealup init` wrote `.github/workflows/deploy.yml`: on every push to `main`, it builds the site
and deploys it. To turn it on:

1. On GitHub, open the repository's **Settings › Secrets and variables › Actions**, and add the
   secret `SEALUP_PASSWORD` with the same password as in `sealup.env`.
2. Commit `sealup.yml` and the workflow (never `sealup.env`), and push to `main`.

The job's log shows the same lines as your terminal, and its summary page gets a table of what
changed. A deploy that stops fails the job, with the reason and a link to its page here. The
workflow lets one deploy run at a time: a newer push waits for the running one.

[The GitHub Action](/github-action/) page explains the step, its inputs and outputs, and how
to pin it.

## Next

- [OVH tutorial](/ovh/): the same steps on OVH.
- [`sealup deploy`](/deploy/): every flag, and what stops a deploy before it changes anything.
- [Exit codes](/exit-codes/): did the server change? The exit code says.
- [Security](/security/): what sealup protects, and how to check a release.
