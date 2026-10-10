# sealup

sealup deploys a local build to a folder on a shared host, over SFTP, SSH or FTP, and deletes only what it uploaded itself.

## Where a deploy goes

**Target**:
A named place a build deploys to: one server, one target folder, its credentials and its rules, as written in `sealup.yml`.
_Avoid_: environment, destination, remote

**Shorthand target**:
The single target of a config written without a `targets:` map.

**Server**:
The host sealup logs into for a target.
_Avoid_: remote, box, hosting

**Login folder**:
The folder the server places a session in right after login.
_Avoid_: home folder (it is often not the home folder)

**Target folder**:
The server folder a target deploys into.
_Avoid_: remote dir, web root, docroot

**Manifest folder**:
The server folder that holds a target's manifest, kept outside every mapping's server folder (it may sit in the target folder beside them).

**Host key**:
The server's public key, pinned in the config; a run connects only to a server that shows it.
_Avoid_: fingerprint (that is how a host key is printed)

**Certificate**:
An FTPS server's TLS certificate, checked before the login: by the trusted CAs and the host name, or against the SHA-256 pinned in `tlsFingerprint`.
_Avoid_: host key (that is SSH's)

**Channel**:
One SFTP channel on a run's single SSH connection. A run opens a few and shares its `parallel` requests in flight among them; each operation stays on one channel.
_Avoid_: connection (an SSH run has one), session (the Session port spans every channel)

**Connection** (FTP):
One logged-in FTP connection of a run's pool, carrying one transfer at a time. Over `ftp://` and `ftps://`, `parallel` counts connections (at most 16); a server that turns some away leaves the run fewer.
_Avoid_: channel (that is SFTP's)

**Lock**:
The folder `<manifest name>.lock` beside a target's manifest, made with `mkdir`, that lets one run at a time deploy to a target folder. It holds a note saying which run holds it. One the server has seen nothing of for 10 minutes is a dead run's, and the next run claims it.
_Avoid_: lockfile (the manifest is no lockfile either), mutex

**Target block**:
The lines that name the resolved target, printed before a run connects.

## What gets sent

**Mapping**:
One source folder sent to a folder under the target folder.
_Avoid_: sync pair, upload entry

**Source folder**:
The local folder of a mapping.
_Avoid_: build dir, dist

**Build**:
Every file the source folders hold when a deploy starts, minus the excluded ones.

**Excluded file**:
A local file that matches the target's `exclude` patterns: never sent, never deleted.

**Hash cache**:
A file on the local machine, outside the project, that keeps each build file's SHA-256 with its size and dates, so an unchanged file is not read and hashed again.
_Avoid_: manifest (that one is on the server)

**Archive**:
Over `ssh://`, the changed files sent as one `tar` stream (or a few side by side) that the server's own `tar` unpacks, instead of file by file over SFTP.
_Avoid_: tarball, bundle

## A deploy

**Deploy**:
One run that makes the target folder hold the build.
_Avoid_: sync, publish, push (upload is one step of a deploy)

**First deploy**:
A deploy to a target folder that has no manifest yet; files already there stay.

**Redeploy**:
A deploy to a target folder that has a manifest.

**Dry run**:
A deploy that shows its plan and changes nothing on the server.
_Avoid_: preview, simulation

**Plan**:
The ordered steps a deploy will take: folders to make, files to upload, files and folders to delete.
_Avoid_: changeset, diff

**Manifest**:
The record of every file sealup uploaded to one target folder, with its size and SHA-256.
_Avoid_: state file, index, lockfile

**Tool-owned**:
Said of a file the manifest records: the only kind of file sealup deletes, unless the mirror is on. A folder goes only when deleting such files leaves it empty.
_Avoid_: managed, ours

**Mirror**:
The option (`--mirror`, or `mirror: true` on a mapping) that also deletes every server file in the mirrored folders that is not in the build, tool-owned or not, except excluded paths and the manifest folder.
_Avoid_: sync, full sync

**Unchanged file**:
A file of the build that the manifest already records with the same SHA-256.

**Kept file**:
A file that a deploy would delete but leaves on the server, for a reason the dry run shows: it is excluded, or the server holds it as a link or behind one and `allow: [symlinks]` leaves server links alone.

**Safety net**:
A check that stops a run before any change, such as an empty source folder or a symlink. A target can turn some of them off on purpose with `allow:`.
_Avoid_: guard

**Partial run**:
A run that stopped after changing the server; running the same command again finishes the job.

## Building sealup

**Scenario**:
A numbered example run (S01, S07, …) whose exact output the CLI page fixes.

**Golden**:
A test that holds a scenario's output byte for byte.
_Avoid_: snapshot

**Gate**:
One automated check every commit must pass.
_Avoid_: hook (a hook only runs the gates)

**Lane**:
One of the parallel build tracks that follow the seam freeze: surfaces, transports, hardening.
_Avoid_: stream, phase

**Spike**:
Throwaway code under `spikes/` that answers one question; never imported.
