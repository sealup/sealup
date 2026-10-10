---
title: SSH
description: Deploy over SSH, with changed files sent as one archive that tar unpacks on the server.
---

`ssh://` is SFTP plus one thing: when the server has a shell and `tar`, the changed files travel
as one compressed archive instead of one by one. On a first deploy of many small files, that
is several times faster. Everything else works as on [SFTP](/sftp/).

```yaml
server: ssh://deploy@ssh.example.com/~
password: ${SEALUP_PASSWORD}
hostKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4R/D1Ip9CHKXPz6VH9sxNwStOVJkTzt9xIQzLywt86
upload:
  dist: www
```

## How it works

1. sealup logs in as over SFTP, after checking the host key.
2. It runs one fixed command once, to know whether the server has `tar` and `gzip`.
3. It packs the changed files itself (no local process) and streams them into one fixed
   command on the server: `tar -xmzf - -C '<folder>'`. A large upload goes as up to four such
   streams side by side, so the server unpacks faster. Each file lands under a hidden
   temporary name, dated by the server's clock.
4. Once the archive is in, the files take their real names over SFTP, many at once, so the
   switch takes a fraction of a second. Into an empty or new folder, files land under their
   real names straight away.
5. Deletes, sealup's file list and its lock go over SFTP, as on `sftp://`.

The target block says which way the files went:

<!-- output: s12-several-targets -->
```text
  staging     ssh://deploy@203.0.113.10:22/srv/site
  host key    SHA256:8H38JEnHSrMlcjtEnYeJa5rF1sOMfr07rcpM5uV9ftM  verified
  transfer    changed files travel as one archive over SSH
```

## No tar, no shell

If the server has no `tar` or `gzip`, or gives no shell to the login, the run goes on file by
file over SFTP and says so:

<!-- output: integration/cli-ssh.test.ts -->
```text
  transfer    file by file over SFTP (no tar on the server)
```

## Safe by design

- The only command sealup ever runs on the server is the fixed `tar` line above. No file name
  goes into it: a file named `$(touch pwned)` stays a file with that name.
- Because the folder does go into that command, an `ssh://` folder may hold only ASCII letters,
  digits and `/ . _ - + @ , = : ~`. Any other folder is refused when sealup reads
  `sealup.yml`; `sftp://` takes it.
- A host key is needed, as on `sftp://`: the faster way is not the less safe one.
- A file that `tar` could not write fails the run with `tar`'s first line of error. A failed
  archive renames nothing: the site keeps its old files, and its temporary files are removed
  (or, if the connection is gone, by the next run). Into an empty folder, where files go under
  their real names, a failed archive may leave some of them: the run ends with exit 1, and
  running it again finishes the job.

## Learn more

- [SFTP](/sftp/): the host key, the login, `parallel`.
- [Private keys](/private-keys/): log in with a key.
- [OVH](/ovh/): `ssh://` on OVH's plans with SSH.
