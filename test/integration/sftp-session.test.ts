// The SFTP transport over the in-process ssh2 server passes the shared Session contract suite
// (decision 0013), the same suite the memory server passes; and the host-key scan's contract.
// Reached as `ssh://`, its sessions pass the archive's contract (0034) through the server's exec
// channel, which reads the archive with testkit's tar reader.

import {
  archiveContract,
  hostKeyScanContract,
  sessionContract,
  sessionFaultContract,
} from '../../src/testkit/index.ts';
import { sftpContractServer, sftpScanServer, sshContractServer } from '../sftp-kit.ts';

sessionContract('SFTP (in-process server)', sftpContractServer);
sessionFaultContract('SFTP (in-process server)', sftpContractServer);
hostKeyScanContract('SFTP (in-process server)', sftpScanServer);
archiveContract('SSH (in-process server)', sshContractServer);
