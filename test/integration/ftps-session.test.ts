// The FTP transport over explicit TLS (`ftps://`, spec #41 decisions 8, 17) passes the shared
// Session contract and fault suites unchanged, against the in-process server showing the
// test-only self-signed certificate, pinned by the target (tlsFingerprint).

import { sessionContract, sessionFaultContract } from '../../src/testkit/index.ts';
import { ftpsContractServer } from '../ftp-kit.ts';

sessionContract('FTPS (in-process server)', ftpsContractServer);
sessionFaultContract('FTPS (in-process server)', ftpsContractServer);
