// The FTP transport passes the Session contract suite against a server that offers no MLST, as
// vsftpd: listings come from LIST in `ls -l` form, and looks from CWD and SIZE (spec #41
// decision 6).

import { sessionContract } from '../../src/testkit/index.ts';
import { ftpContractServer } from '../ftp-kit.ts';

sessionContract('FTP, LIST only (in-process server)', () => ftpContractServer({ mlsd: false }));
