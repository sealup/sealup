// contracts: the shared types and ports (decision 0009).
//
// Decision hidden: none. This is the one place where modules agree on shapes, so a change to a
// shared type is one visible edit here. Frozen by decision 0026, with the other seams. The change
// rule: an addition (an event, a PlanOp, a Problem, a Capabilities field) is a visible edit, its
// golden in test/integration/goldens/seams/ updated on purpose and listed in the pull request; a
// breaking change (a rename, a removal, a new meaning, a new exit code) or a manifest or `--json`
// format bump needs a decision record first. A new manifest field means format 2, format 1 still
// read. Comments are not shapes: editing one leaves the shape golden alone.
//
// Interface: types only, plus error classes, three constants and one predicate, in one file per
// concern (spec sealup/sealup#24, decision 4). This entry file re-exports every public name, one
// by one (Biome forbids `export *`); other modules import from it only. An addition goes in its
// concern's file and in the list below:
//
//   brands.ts   RemotePath, ServerPath and Sha256 (branded), Secret, shortestSecret
//   session.ts  the Session port (Capabilities, Source, ReadResult, ServerEntry, StatResult,
//               ListResult), Connect, TransportError and its codes, reasons and operations, HostKeyId (the
//               key a server sent), the host-key scan port (ScanHostKey, ScannedHostKey), the
//               SSH archive port (ArchiveUpload, ArchiveFile; 0034), ServerCertificate and the
//               certificate scan port (ScanCertificate, CertificateScan; FTPS)
//   config.ts   the SFTP Target (ServerUrl, HostKey, Mapping, SecretFile, PullEntry,
//               AllowedRisk, its config places), ConfigPlace, ConfigIssue and ConfigExpected,
//               VariableSource, maxFtpConnections (FTP's cap on parallel), isFtp(protocol)
//   plan.ts     LocalFile and LocalTree, Manifest (format 2), FileRecord, ManifestRead,
//               EmptySource, PlanInput, WriteRead, ServerCheck and ListedFile (the server
//               check), MirrorListing (the full mirror), PlanOp (mkdir, upload, write,
//               delete, rmdir), KeptFile, Plan, PlanBlock
//   run.ts      Problem and PartialRun, Timings, Outcome and FailedOp, HostKeyCheck, LockHolder,
//               Progress, RunWarning, DeployEvent and the Reporter port, CheckReport
//               (TargetCheck, UploadCheck), KeyscanReport, CertificateReport (FTPS), ExitCode;
//               UnsafeName (a server name a pull refuses)
//   pull.ts     `sealup pull`: PullDownload, PullPlan, PullEvent and the PullReporter port
//
// A new file goes in shapeFiles (test/freeze-kit.ts), or the freeze test fails. Nothing guessed
// beyond what the code uses: each ticket adds its own types (a PlanOp, a Problem, an event) when
// it first needs them. Events and problems hold facts, never words: report words them.
//
// Invariants: a port exists only where two adapters exist (Session: memory and SFTP; Reporter:
// terminal and JSON). Ports are plain types, passed as parameters; no DI framework.
//
// Must never know: any implementation, any library, Node itself (pure: no node: import).

export {
  type RemotePath,
  type Secret,
  type ServerPath,
  type Sha256,
  shortestSecret,
} from './brands.ts';
export {
  type AllowedRisk,
  type ConfigExpected,
  type ConfigIssue,
  type ConfigPlace,
  type HostKey,
  isFtp,
  type Mapping,
  maxFtpConnections,
  type PullEntry,
  type SecretFile,
  type ServerUrl,
  type Target,
  type VariableSource,
} from './config.ts';
export type {
  EmptySource,
  FileRecord,
  KeptFile,
  ListedFile,
  LocalFile,
  LocalTree,
  Manifest,
  ManifestRead,
  MirrorListing,
  Plan,
  PlanBlock,
  PlanInput,
  PlanOp,
  ServerCheck,
  WriteRead,
} from './plan.ts';
export type { PullDownload, PullEvent, PullPlan, PullReporter } from './pull.ts';
export {
  type CertificateReport,
  type CheckReport,
  type DeployEvent,
  ExitCode,
  type FailedOp,
  type HostKeyCheck,
  type KeyscanReport,
  type LockHolder,
  type MirroredPull,
  type Outcome,
  type PartialRun,
  type Problem,
  type Progress,
  type Reporter,
  type RunWarning,
  type TargetCheck,
  type Timings,
  type UnsafeName,
  type UploadCheck,
} from './run.ts';
/**
 * No module names this type: they read it as TransportError's `reason`. Before the split, its use
 * in TransportError, in the same file, kept knip quiet; `@public` keeps it re-exported, unchanged.
 * @public
 */
export type { TransportReason } from './session.ts';
export {
  type ArchiveFile,
  type ArchiveUpload,
  type Capabilities,
  type CertificateScan,
  type Connect,
  type HostKeyId,
  type ListResult,
  type PutOptions,
  type ReadResult,
  type ScanCertificate,
  type ScanHostKey,
  type ScannedHostKey,
  type ServerCertificate,
  type ServerEntry,
  type Session,
  type Source,
  type StatResult,
  TransportError,
  type TransportErrorCode,
  type TransportOperation,
} from './session.ts';
