// testkit: fakes and shared suites for tests (dev only, never bundled).
//
// Decision hidden: how a test gets a server: the in-memory Session, the in-process SFTP and FTP
// servers with fault injection, and the Session contract suite every transport passes (decision
// 0013); the leak-test harness: canary secrets and the search for them in all output and written files
// (R1, leak.ts).
//
// Interface: test helpers, imported by tests through this entry file only.
//   sessionContract(name, factory)       the Session contract tests; the factory returns a fresh
//                                        server ({ connect(options?), seedLink(path, target),
//                                        stop?() }) per test
//   sessionFaultContract(name, factory)  the fault tests, for servers that also have `faults`
//                                        (failWrite(nth, code), dropDuringRead(nth),
//                                        changeDuringRead(path, bytes), refuseLogin(), slow(ms))
//   archiveContract(name, factory)       the SSH archive's tests (0034): the factory returns a
//                                        fresh server whose sessions carry `archive`, with
//                                        faults dropArchive(), failArchive(), stallArchive()
//   hostKeyScanContract(name, factory)   the host-key scan's tests (the key shown, no login);
//                                        the factory returns { scan(options?), hostKeyLine,
//                                        fingerprint, logins(), closed(), stop?() }
//   createMemoryServer(options)          the memory server: connect({ timeoutMs }), faults,
//                                        scanHostKey (the scan port), hostKeyLine, fingerprint,
//                                        logins(), closed(),
//                                        files() (with mtime, mode and the mode at the
//                                        first byte, R17), folders(),
//                                        seedFile(path, content, { mtime, mode }?),
//                                        seedLink(path, target), seedOther(path),
//                                        seedFolder(path, { mtime }?), passTime(ms) (its clock)
//   createSftpServer(options)            the in-process SFTP server (ssh2 server mode on
//                                        127.0.0.1, files in memory, answers like OpenSSH's
//                                        sftp-server without extensions): host, port, user,
//                                        password, hostKeyLine, fingerprint, faults (plus
//                                        refuseChannelsBeyond(n), stallChannelsBeyond(n),
//                                        closeChannelOnOpen(nth), closeChannelOnWrite(nth),
//                                        afterFailedMkdir(path, meanwhile)),
//                                        logins(), closed(), mostInFlight(), readdirs(),
//                                        channels() (per connection), files(), folders(),
//                                        seedFile(),
//                                        seedLink(), seedOther(), seedFolder(), stop();
//                                        test/sftp-kit.ts connects the real transport to it
//   createFtpServer(options)             the in-process FTP server (node:net on 127.0.0.1, files
//                                        in memory; options turn off MLST, EPSV, RNTO's replace,
//                                        SITE CHMOD, or cap connections; PASV may name another
//                                        address): host, port, user, password, faults (plus
//                                        longReply(bytes)), commands(), logins(),
//                                        dataAddresses(), closed(), files(), folders(),
//                                        seedFile(), seedLink(), seedOther(), seedFolder(), stop();
//                                        test/ftp-kit.ts connects the real FTP transport to it;
//                                        with `tls` it is explicit FTPS (AUTH TLS, PROT P), and
//                                        dataTls() tells each data connection's TLS session
//   testCertificates, testServerKey,     TEST-ONLY TLS certificates and key for that server
//   testCa                               (self-signed; CA-signed for 127.0.0.1; CA-signed for
//                                        another name) with OpenSSL's SHA-256 of each
//   canaries, expectNoLeaks(places)      the leak test: CLI tests run with `canaries` in their
//   findLeaks(places), readTree(folder)  environment and pass what the run left behind (stdout,
//                                        stderr, the JSON object, the server's files) to
//                                        `expectNoLeaks`; test/cli-kit.ts does both for a CLI
//                                        run in a child process
//   splitMasks(log)                      a GitHub-form log's leading `::add-mask::` lines (the
//                                        one place a secret is written, R2) and the rest
//   userKey({ passphrase? })             a fresh test-only ed25519 login key: the private key
//                                        file (OpenSSH form) and its authorized_keys line;
//                                        createSftpServer({ authorizedKeys }) accepts it
//   readTar(gzipped)                     a strict reader of transport's gzip tar stream: the
//                                        files (name, size, mode, mtime, bytes), in order;
//                                        throws on anything the packer must not write (tar.ts)
//   steppedClock(...times)               a clock with fixed readings, so durations are exact
//   goldenText(lines, { color })         a golden written in the CLI page's colour markup
//                                        ({g}, {b}, {d}, {gb}, … {/}) as the bytes a reporter
//                                        writes, with colour on or off (golden.ts)
//   screenOf(raw)                        what a terminal shows once a stream is written: the
//                                        progress line, erased by the next line, is gone; a
//                                        prompt's redraws (cursor up, erase down) are applied
// The server types live in session-contract-kit.ts; export them here when a test first needs one
// by name (knip refuses unused exports).
//
// Invariants: the memory fake and every real transport pass the same contract suite, so the fake
// cannot drift from real behaviour. No product module imports testkit.
//
// Must never know: the plan rules, the CLI, how output is printed.

export { archiveContract } from './archive-contract.ts';
export { steppedClock } from './clock.ts';
export { createFtpServer, type FtpServer } from './ftp-server.ts';
export { goldenText, screenOf } from './golden.ts';
export { userKey } from './keys.ts';
export {
  canaries,
  canaryKeyLine,
  expectNoLeaks,
  findLeaks,
  readTree,
  splitMasks,
} from './leak.ts';
export { createMemoryServer } from './memory.ts';
export { hostKeyScanContract } from './scan-contract.ts';
export {
  type ServerLimits,
  sessionContract,
  sessionFaultContract,
} from './session-contract.ts';
export { createSftpServer, type SftpServer } from './sftp-server.ts';
export { readTar } from './tar.ts';
export { testCa, testCertificates, testServerKey } from './tls-certificates.ts';
