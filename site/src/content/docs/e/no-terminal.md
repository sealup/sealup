---
title: 'init needs the server address'
description: 'sealup init ran without a terminal and without --server.'
---

```text
  ✗ sealup init needs the server address.
    There is no terminal to ask in, so pass it as a flag:
    sealup init --server sftp://user@host/folder

    More: sealup.dev/e/no-terminal
```

**Exit code:** 2. **Server changed:** no: nothing was written.

## What happened

`sealup init` ran without a terminal (in CI, or with its input piped), and without `--server`.

## Why

On a terminal `init` asks for the server address. Without one there is no one to ask.

## The fix

Pass the address as a flag:

```sh
sealup init --server sftp://deploy@ssh.example.com/home/site/www
```

Then fill in the host key on your own machine with [`sealup keyscan`](/keyscan/).
