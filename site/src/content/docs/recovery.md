---
title: Recovering a deployment
description: Restore a known-good app without overwriting runtime data or trusting stale deployment state.
---

Rehearse recovery on a disposable target before relying on it for a live app. An archive's
existence alone does not prove that it can be restored.

## Prepare before deploying

Keep a known-good local artifact and its matching env and other mapped files. Save a private
server archive of those app files outside the deployment folders, with access limited to
the people who operate the app. Include the config and record which target it belongs to.
Do not put credentials, archives or generated env contents in Git.

Exclude runtime resources, uploads, caches and storage from the app archive as well as from
deployment. Back up databases separately: restoring PHP or frontend files does not restore
database contents, and a schema change may prevent an older app from running.

## Restore and reconcile

1. Stop deployments and app writes while recovering. Confirm the selected archive and target.
2. Restore the app archive into that target folder without replacing its runtime data or
   databases. Restore the matching local artifact and local env files too.
3. Independently verify the restored files, permissions and app responses. Do not assume
   that a successful extract proves the app works.
4. Review and deploy that same local artifact with the server check enabled:

   ```sh
   sealup deploy production --check-server --dry-run
   sealup deploy production --check-server
   sealup deploy production --check-server --dry-run
   ```

5. Verify app/API behavior and runtime data again. The final dry run should have no changes.

A restore done outside sealup can leave its manifest describing a different app version.
Deploying the matching known-good artifact reconciles that state. Review every planned
upload and delete before applying. `--mirror` is not a recovery shortcut: it also deletes
files sealup did not upload.

[`--check-server`](/check-server/) detects missing files, changed sizes and newer dates.
It does not hash every server file: an edit that keeps the same size and an older date can
be missed. Compare important restored files independently and verify the running app.
The check supplements recovery verification; it does not replace it.

## What to prove in a rehearsal

Deploy a known-good fixture, save it, deploy a changed version, and simulate a broken or
missing app file. Restore the saved version, deploy its matching local artifact with
`--check-server`, then confirm an unchanged redeploy. Keep distinct sentinel files in
excluded resource/storage folders and confirm they survive every step. Use synthetic env
values and an isolated manifest directory, and remove the disposable fixture afterward.

For local migration examples and exclusions, see [Migrating from sam-sync](/migrate-sam-sync/).
