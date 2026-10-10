// keyscan: `sealup keyscan [target]`, the server's host key shown against the saved one (spec
// #24 decision 18, S04, R7).
//
// Decision hidden: which target is scanned, what of its config the scan needs (its server, its
// saved key, its timeout: nothing else, so an unset password never stops it), and how the key
// shown compares with the saved one.
//
// Interface: keyscanTarget(config, name) gives the target to scan (KeyscanTarget), or the
// problem that stops before scanning (a name not in the file, several targets and none named,
// a server or hostKey the config cannot read). scanKey(target, scan, signal) scans it through
// the host-key scan port and gives a KeyscanReport (facts; report words them), or the transport
// problem. notReplaced(report, asked) is the problem of another key left in place (exit 4). cli
// asks the question and saves the key through config (saveHostKey). An `ftp://` target has no
// key: cli scans nothing and says so, exit 0 (spec #41 decision 12). An `ftps://` target shows its
// certificate instead: scanPin(target, scan, signal) scans it through the certificate scan port
// and gives a CertificateReport (trusted, a pin offered, pinned, or another pin), and
// pinNotReplaced(report, asked) is the problem of another pin left in place (exit 4); cli saves
// a pin through config (saveTlsFingerprint).
//
// Invariants: no credential is read for the scan or given to it; nothing here writes.
//
// Must never know: argv, the terminal, how anything is worded, ssh2.

import { closestTargetName, type ResolvedConfig } from '../config/index.ts';
import {
  type CertificateReport,
  type ConfigPlace,
  type HostKey,
  type KeyscanReport,
  type Problem,
  type ScanCertificate,
  type ScanHostKey,
  type ServerUrl,
  TransportError,
} from '../contracts/index.ts';

/** What a scan of one target needs: never its password. */
export interface KeyscanTarget {
  readonly name: string;
  readonly configFile: string;
  readonly server: ServerUrl;
  /** The `server` key's place: what the words of a plain-FTP target point at. */
  readonly place: ConfigPlace;
  readonly hostKey?: { readonly key: HostKey; readonly place: ConfigPlace };
  /** `ftps://`: the pinned certificate's SHA-256 and its place, when there is one. */
  readonly tlsFingerprint?: { readonly sha256: string; readonly place: ConfigPlace };
  readonly timeoutMs: number;
}

/**
 * The target to scan: the one named, or the only one. A target is scanned whatever else is wrong
 * in it (an unset password, a missing upload folder): only a problem with its server or its
 * hostKey stops the scan.
 */
export function keyscanTarget(
  config: ResolvedConfig,
  name: string | undefined,
): { readonly target: KeyscanTarget } | { readonly problem: Problem } {
  const names = [...config.targets.keys()];
  const configFile = config.file;
  const chosen = name ?? (names.length === 1 ? names[0] : undefined);
  if (chosen === undefined) {
    return { problem: { code: 'target-not-named', names, configFile, command: 'keyscan' } };
  }
  const entry = config.targets.get(chosen);
  if (entry === undefined) {
    const suggestion = closestTargetName(chosen, names);
    return {
      problem: {
        code: 'unknown-target',
        name: chosen,
        names,
        configFile,
        command: 'keyscan',
        ...(suggestion === undefined ? {} : { suggestion }),
      },
    };
  }
  const { connection } = entry;
  const issues = entry.ok ? [] : entry.issues;
  const blocking = issues.filter((issue) =>
    /(?:^|\.)(?:server|hostKey|tlsFingerprint)$/.test(issue.keyPath),
  );
  if (connection === undefined || blocking.length > 0) {
    const shown = blocking.length > 0 ? blocking : issues;
    return { problem: { code: 'config', issues: shown, target: chosen } };
  }
  return {
    target: {
      name: chosen,
      configFile,
      server: connection.url,
      place: connection.place,
      ...(connection.hostKey === undefined ? {} : { hostKey: connection.hostKey }),
      ...(connection.tlsFingerprint === undefined
        ? {}
        : { tlsFingerprint: connection.tlsFingerprint }),
      timeoutMs: connection.timeoutMs,
    },
  };
}

/**
 * The problem of a key not replaced (exit 4): the server shows another key than the saved one,
 * and the answer was no (`asked`) or there was no terminal to ask.
 */
export function notReplaced(report: KeyscanReport, asked: boolean): Problem {
  const { saved } = report;
  if (report.state !== 'other' || saved === undefined) {
    throw new RangeError('only another key than the saved one is not replaced');
  }
  return {
    code: 'host-key-not-replaced',
    target: report.target,
    server: report.server,
    configFile: report.configFile,
    expected: saved.key,
    place: saved.place,
    received: report.shown,
    asked,
  };
}

/** Scans the target's server, asking for its saved key's type first, and compares the keys. */
export async function scanKey(
  target: KeyscanTarget,
  scan: ScanHostKey,
  signal: AbortSignal | undefined,
): Promise<{ readonly report: KeyscanReport } | { readonly problem: Problem }> {
  const saved = target.hostKey;
  try {
    const shown = await scan(target.server, {
      signal,
      timeoutMs: target.timeoutMs,
      ...(saved === undefined ? {} : { type: saved.key.type }),
    });
    const facts = {
      configFile: target.configFile,
      target: target.name,
      server: target.server,
      shown,
    };
    if (saved === undefined) return { report: { ...facts, state: 'not-saved' } };
    // The fingerprint is the key blob's, and the blob names its type.
    const same = saved.key.fingerprint === shown.fingerprint;
    return {
      report: {
        ...facts,
        saved: {
          key: { type: saved.key.type, fingerprint: saved.key.fingerprint },
          place: saved.place,
        },
        state: same ? 'same' : 'other',
      },
    };
  } catch (error) {
    if (!(error instanceof TransportError)) throw error;
    if (error.reason === 'interrupted') return { problem: { code: 'interrupted', changed: false } };
    return { problem: { code: 'transport', error, changed: false } };
  }
}

/**
 * Scans an `ftps://` target's certificate (spec #41 decision 12) and compares it with the pin:
 * `trusted` (no pin, the normal check passes: nothing to pin), `not-saved` (no pin, the check
 * fails: a pin is offered), `same` or `other`.
 */
export async function scanPin(
  target: KeyscanTarget,
  scan: ScanCertificate,
  signal: AbortSignal | undefined,
): Promise<{ readonly report: CertificateReport } | { readonly problem: Problem }> {
  const saved = target.tlsFingerprint;
  try {
    const shown = await scan(target.server, { signal, timeoutMs: target.timeoutMs });
    const facts = {
      configFile: target.configFile,
      target: target.name,
      server: target.server,
      shown,
    };
    if (saved === undefined) {
      return { report: { ...facts, state: shown.check === 'trusted' ? 'trusted' : 'not-saved' } };
    }
    const same = saved.sha256 === shown.certificate.sha256;
    return { report: { ...facts, saved, state: same ? 'same' : 'other' } };
  } catch (error) {
    if (!(error instanceof TransportError)) throw error;
    if (error.reason === 'interrupted') return { problem: { code: 'interrupted', changed: false } };
    return { problem: { code: 'transport', error, changed: false } };
  }
}

/**
 * The problem of a pin not replaced (exit 4): the server shows another certificate than the
 * pinned one, and the answer was no (`asked`) or there was no terminal to ask.
 */
export function pinNotReplaced(report: CertificateReport, asked: boolean): Problem {
  const { saved } = report;
  if (report.state !== 'other' || saved === undefined) {
    throw new RangeError('only another certificate than the pinned one is not replaced');
  }
  return {
    code: 'certificate-not-replaced',
    target: report.target,
    server: report.server,
    configFile: report.configFile,
    expected: saved.sha256,
    place: saved.place,
    received: report.shown.certificate,
    asked,
  };
}
