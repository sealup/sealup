// The FTP transport over the in-process FTP server passes the shared Session contract suite
// (decision 0013), the same suite the memory server and SFTP pass. A server with MLSD here; one
// that offers only LIST in ftp-session-list.test.ts (its own file, so the two run in parallel).

import { sessionContract, sessionFaultContract } from '../../src/testkit/index.ts';
import { ftpContractServer } from '../ftp-kit.ts';

sessionContract('FTP (in-process server)', ftpContractServer);
sessionFaultContract('FTP (in-process server)', ftpContractServer);
