// Login keys for tests (decision 0033): a fresh ed25519 key pair made in this process, never a
// key from disk and never the owner's. The private key is in OpenSSH's file form (several lines,
// as `ssh-keygen` writes it), encrypted when a passphrase is given; the public key is the line an
// `authorized_keys` file holds.

import ssh2 from 'ssh2';

const { utils } = ssh2;

/** A test-only login key pair. */
export interface UserKey {
  /** The private key file, OpenSSH form, ending with a line break. */
  readonly private: string;
  /** `ssh-ed25519 <base64>`: the authorized_keys line. */
  readonly publicLine: string;
}

/**
 * A fresh ed25519 key pair, encrypted with `passphrase` when one is given. ssh2 1.17 writes an
 * ed25519 key it cannot read back about once in 250 (sftp-server.ts), so a key is kept only once
 * ssh2 parses it.
 */
export function userKey(options: { readonly passphrase?: string } = {}): UserKey {
  const { passphrase } = options;
  for (;;) {
    const pair =
      passphrase === undefined
        ? utils.generateKeyPairSync('ed25519')
        : utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 16 });
    if (utils.parseKey(pair.private, passphrase) instanceof Error) continue;
    return {
      private: pair.private.endsWith('\n') ? pair.private : `${pair.private}\n`,
      publicLine: pair.public.split(' ').slice(0, 2).join(' '),
    };
  }
}
