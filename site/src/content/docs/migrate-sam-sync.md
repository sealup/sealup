---
title: Migrating from sam-sync
description: Preserve your uploads, renamed env files and runtime data when moving to sealup.
---

Start with one project and review every mapping before deploying. Keep the existing build
command: sealup sends its output, it does not build the app or update its database.

## Convert and review

From the project folder, with no existing `sealup.yml`:

```sh
sealup init --from .deployment.json
```

On a terminal, `sealup init` also offers conversion when it finds `.deployment.json`.
Conversion writes a config, local connection secrets and, if absent, a GitHub workflow;
it does not deploy the app. Without a terminal, the host key needs to be supplied separately
using [`sealup keyscan`](/keyscan/) and an independently trusted key.

Compare the result to the old deployment and download configs, including every destination,
exclude, renamed file and pull. Conversion reports entries it cannot preserve; do not deploy
until each omission has been explained. Pull exclusions and pulls using another server need
manual handling. An old `dry: true` does not make sealup deployments dry: pass `--dry-run`.
The generated workflow also needs a review of your actual branch, build and secret setup.

Repeated upload sources are retained as destination lists, with each directory's exclusions
kept on that mapping. The conversion keeps the legacy server and target folder; it does not
guess separate targets from destination names. For separately controlled instances, split
the config deliberately as below.

## Two instances with shared files

Here both targets upload the same API and public build but use different env and Compose
files. Their server variables contain complete URLs with different target folders. They
share a password and host key because they use the same SSH account and server:

```yaml
upload:
  root/public_html:
    to: public_html
    exclude: ["resources/"]
  root/api:
    to: api
    exclude: [".env*", "storage/"]
targets:
  production:
    server: ${PRODUCTION_SERVER}
    password: ${SEALUP_PASSWORD}
    hostKey: ${SEALUP_HOST_KEY}
    upload:
      root/api/.env.prod: api/.env
      root/docker-compose.yml: docker-compose.yml
    pull:
      public_html/resources: root/public_html/resources
  preview:
    server: ${PREVIEW_SERVER}
    password: ${SEALUP_PASSWORD}
    hostKey: ${SEALUP_HOST_KEY}
    upload:
      root/api/.env.preview: api/.env
      root/docker-compose.preview.yml: docker-compose.yml
```

Shared uploads are **added** to each target's uploads. A target does not override a shared
entry; two entries that land on the same server path are a collision. Root `upload` can be
omitted if all uploads are declared in targets; no empty `{}` is needed.

The folder exclusions are relative to that source folder. They keep runtime resources and
storage out of uploads and deletions, and omit env source files from the directory upload.
The explicit file mapping sends only the selected env file as `api/.env`. Global `exclude`
patterns remain config-relative and still block explicit mappings: a scoped exclusion cannot
undo a global one. See [`sealup.yml`](/config/) for both forms.

Matching files left by earlier deployments are also protected from deletion; review any
cleanup of old env source copies separately.

## Keep local env files local

The converter keeps `.env*` file mappings as ordinary uploads and adds their source paths
to `.gitignore`, even if a file needs to be supplied later. Each deploy reads the current
file; an app version bump or password change in that file is included on the next deploy.
There is no copied `APP_ENV` content to keep in sync and no custom launcher.

Keep `sealup.env` and application env files ignored by Git, provision them separately on
a new checkout, and ensure the API directory is outside the public document root.
Adding an ignore rule does not remove an already tracked file or erase old Git history;
review those separately before sharing a repository.

Ordinary uploads use the normal upload permission behavior. Check that the app's runtime
account can read the resulting env file, especially when it differs from the deploy account.
The explicit env upload remains an ordinary upload: it does not gain `write`'s private-mode
or public-folder checks.

For CI-provided whole-file secrets, [`write`](/write/) is still useful: the content comes from
one variable rather than a local file, and the default mode is `0600`. If the runtime needs
access through a shared group, use the long form with an appropriate mode such as `0640`
and the matching group ownership. Do not make every secret world-readable as a blanket fix.

## First deployment

Save a known-good app artifact, env files and a recovery archive first. Protect resources,
storage and any other app-owned data with exclusions. Database backups are separate.

```sh
sealup check production
sealup deploy production --dry-run
sealup deploy production
sealup deploy production --dry-run
```

Repeat for preview after production is verified, or reverse the order if preview is your
test instance. Name every target explicitly in scripts. Run them sequentially so a failed
first deploy stops later targets, then verify the app, API and uploaded resources.

The first deploy has no previous sealup manifest: existing server files may remain, and
the configured artifact is uploaded to establish the manifest. Do not turn on `--mirror`
just to tidy the migration; it can delete old files sealup did not upload. Review pull
operations with `sealup pull production --dry-run` before copying resources locally.

After an unchanged redeploy and a disposable recovery rehearsal, remove the old sam-sync
scripts and configs. Keep the [recovery procedure](/recovery/) and archives available.
