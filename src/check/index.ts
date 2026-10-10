// check: `sealup check [target]`, the config and its variables checked offline (spec #24
// decision 14, S06).
//
// Decision hidden: which targets are checked, what each one's problem is, and the exit code.
// A target's problem is the one a deploy to it would stop on before connecting (deploy's own
// steps, run alone: the config, the manifest folder, the scan, two entries on one path, the
// nets), then a missing host key (exit 4).
//
// Interface: check(config, name) returns a CheckReport (facts; report words them), or the
// problem that stops the whole check (a target name not in the file).
//
// Invariants: never connects, never writes, never reads a variable's value beyond what config
// already did; the report names variables and where they came from, never a value (R6). Exit:
// the named target's code; without a name, 0 when at least one target is ready, else the first
// target's.
//
// Must never know: argv, the terminal, how anything is worded, the server.

import type { ResolvedConfig } from '../config/index.ts';
import {
  type CheckReport,
  ExitCode,
  isFtp,
  type Mapping,
  type Problem,
  type TargetCheck,
  type UploadCheck,
} from '../contracts/index.ts';
import { beforeConnecting, mirroredPulls, stopped } from '../deploy/index.ts';
import type { ScanResult } from '../scan/index.ts';

export async function check(
  config: ResolvedConfig,
  name: string | undefined,
): Promise<CheckReport | { readonly problem: Problem }> {
  const names = name === undefined ? [...config.targets.keys()] : [name];
  const targets: TargetCheck[] = [];
  for (const each of names) {
    const found = await checkTarget(config, each);
    if (found.problem?.code === 'unknown-target') {
      return { problem: { ...found.problem, command: 'check' } };
    }
    targets.push(found);
  }
  const [first] = targets;
  const ready = targets.some((target) => target.problem === undefined);
  const exitCode = name === undefined && ready ? ExitCode.ok : (first?.exitCode ?? ExitCode.usage);
  return {
    configFile: config.file,
    envFile: config.envFile,
    named: name !== undefined,
    targets,
    exitCode,
  };
}

async function checkTarget(config: ResolvedConfig, name: string): Promise<TargetCheck> {
  const before = await beforeConnecting(config, name);
  const entry = config.targets.get(name);
  // Ruling 2: the pull: folders a mirrored mapping would delete.
  const pulls = entry?.ok === true ? mirroredPulls(entry.target) : [];
  const facts = {
    name,
    variables: entry?.variables ?? [],
    hostKey: entry?.hostKey ?? 'unknown',
    ...(entry === undefined ? {} : { login: entry.login }),
    ...(entry?.ok === true ? { target: entry.target } : {}),
    ...(pulls.length > 0 ? { mirroredPulls: pulls } : {}),
    ...(before.scanned !== undefined && entry?.ok === true
      ? { uploads: uploadsOf(entry.target.uploads, before.scanned) }
      : {}),
  };
  const problem: Problem | undefined =
    'problem' in before
      ? before.problem
      : // FTP and FTPS have no host key to save (spec #41 decision 10).
        before.target.hostKey === undefined && !isFtp(before.target.server.protocol)
        ? { code: 'host-key-missing', configFile: config.file }
        : undefined;
  if (problem === undefined) return { ...facts, exitCode: ExitCode.ok };
  return { ...facts, problem, exitCode: stopped(problem, 0).exitCode };
}

/** Each upload entry with the files it sends, in config order. */
function uploadsOf(mappings: readonly Mapping[], scanned: ScanResult): UploadCheck[] {
  return mappings.map((mapping) => ({
    local: mapping.localFromConfig,
    kind: mapping.kind,
    files: scanned.sent.filter((sent) => sent.mapping === mapping).length,
  }));
}
