// contracts, brands and secrets: the branded strings (paths, SHA-256) and the Secret every
// module passes around. Additions here: a new brand, a new rule every secret follows.

// ---------------------------------------------------------------------------------------------
// Paths (R10). Two kinds, never mixed (ruling 7, 2026-10-07):
//
// - RemotePath: a path RELATIVE to the target folder, as the plan and the manifest know it.
//   Only `paths` makes one, so every RemotePath passed the one strict rule.
// - ServerPath: an ABSOLUTE POSIX path on the server. The Session port takes only ServerPaths.
//   connect() resolves the login folder (what the server reports for `.`); the target folder
//   (absolute, or `/~/…` resolved against the login folder) and the manifest folder are
//   ServerPaths. A RemotePath reaches the server only through paths' join, which cannot escape
//   the folder it joins into.
// ---------------------------------------------------------------------------------------------

/** Relative, `/`-separated, no `..`, no empty or `.` segment, no control character, NFC (R10). */
export type RemotePath = string & { readonly __brand: 'RemotePath' };

/** Absolute POSIX path on the server: `/` or `/a/b`, segments as strict as a RemotePath's. */
export type ServerPath = string & { readonly __brand: 'ServerPath' };

// ---------------------------------------------------------------------------------------------
// Secrets (R1, R3, R4)
// ---------------------------------------------------------------------------------------------

/**
 * An opaque credential. Only `secret` makes one; it prints as `[secret]` everywhere (toString,
 * toJSON, util.inspect) and holds no readable copy of its value. Only `transport` reveals it.
 */
export interface Secret {
  /** The environment variable it came from, so messages can cite it (R6); never the value. */
  readonly envName: string;
  toString(): string;
  toJSON(): string;
}

/** R2: the fewest characters (code points) a secret may have; a shorter one is refused. */
export const shortestSecret = 6;

/** SHA-256 of a file's bytes, lowercase hex. */
export type Sha256 = string & { readonly __brand: 'Sha256' };
