// The words of a deploy's server listing that passed one of R21's caps (spec #41 decisions 26,
// 29 and 31): what happened, why sealup stops, the one fix, the state. Pure (import rules, pure
// file): no node: import.

import type { Problem } from '../contracts/index.ts';
import { formatCount, printable } from './format.ts';
import type { Explained } from './problems.ts';

export function explainListing(
  problem: Extract<Problem, { code: 'listing-too-large' }>,
  nothing: string,
): Explained {
  const max = formatCount(problem.max);
  const mirror = problem.for === 'mirror';
  return {
    title:
      problem.limit === 'entries'
        ? `The ${mirror ? 'mirror' : 'server check'} listed over ${max} entries: sealup stopped listing.`
        : `${printable(problem.path)} is over ${max} folders deep: sealup stopped listing.`,
    details: [
      'sealup reads only that much from a server, so a broken or hostile one',
      ...(mirror
        ? [
            'cannot keep it listing. Exclude the large server folders (never listed),',
            'or deploy without the mirror: drop --mirror, or mirror: true.',
          ]
        : [
            'cannot keep it listing. Deploy without the server check: drop',
            '--check-server, or checkServer: true in sealup.yml.',
          ]),
    ],
    state: [nothing],
    slug: 'listing-too-large',
  };
}
