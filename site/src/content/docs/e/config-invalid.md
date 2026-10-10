---
title: 'Problems in sealup.yml'
description: 'sealup.yml has keys or values sealup cannot use.'
---

```text
  ✗ sealup.yml has 2 problems.
    targets.production.paralel (line 7): unknown key; sealup stops on it
    timeout (line 3): write a duration like 30s or 2m

    More: sealup.dev/e/config-invalid
```

**Exit code:** 2. **Server changed:** no.

## What happened

sealup read `sealup.yml` and found keys or values it cannot use. Each line of the error gives the key, its line, and what to write instead.

## Why

The common causes:

- a key sealup does not know, often a typo: sealup stops on it rather than ignore it;
- a value of the wrong kind (a number, a list, a duration like `30s`);
- a server address that is not `sftp://user@host[:port]/folder`;
- a path with `..` or a leading `/` where a folder inside the target is needed;
- a variable written wrong (write `${NAME}`, or `$$` for one `$`);
- a secret that is too short, or holds a line break;
- a file's content written in a `write:` entry instead of one `${NAME}`;
- server keys at the top level next to `targets:` (move them into each target);
- YAML that does not parse.

## The fix

Fix each line the error lists, then check the file without touching the server:

```sh
sealup check
```

Every key and the values it takes: [`sealup.yml`](/config/).
