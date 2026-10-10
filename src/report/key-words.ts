// The words of a private key sealup cannot read (decision 0033): not a key it reads, an
// encrypted one without a passphrase, or a passphrase that does not open it. Variable names and
// places only, never a value (R6). Pure (import rules, pure file): no node: import.

import type { ConfigPlace, Problem, Target } from '../contracts/index.ts';
import { lineOf, lineWord } from './format.ts';
import type { Explained } from './problems.ts';

type KeyProblem = Extract<Problem, { code: 'private-key-unreadable' }>;

/**
 * `targets.production.privateKey (sealup.yml line 5) reads ${DEPLOY_KEY}.`, in the file the run
 * was given; none when the variable is not known.
 */
function readsLine(
  place: ConfigPlace | undefined,
  variable: string | undefined,
  file: string,
): string[] {
  if (variable === undefined) return [];
  if (place === undefined) return [`${file} reads $\{${variable}}.`];
  return [`${place.keyPath} (${file}${lineWord(place)}) reads $\{${variable}}.`];
}

export function explainKey(
  problem: KeyProblem,
  target: Target | undefined,
  file: string,
  ci: boolean,
): Explained {
  const variable = target?.privateKey?.envName;
  const key = variable ?? 'privateKey';
  const keyPlace = target?.places.privateKey;
  const state = [`sealup did not connect. Nothing was changed on ${problem.target}.`];
  const slug = 'private-key-unreadable';
  switch (problem.reason) {
    case 'key-unreadable':
      return {
        title: `sealup cannot read the private key in ${key}.`,
        details: [
          ...readsLine(keyPlace, variable, file),
          'It must be the whole key file (OpenSSH or PEM), as ssh-keygen writes it,',
          'with its BEGIN and END lines.',
          ci
            ? 'Paste the whole file into the secret, line breaks included.'
            : 'In sealup.env, write it in double quotes, over several lines.',
        ],
        state,
        slug,
      };
    case 'passphrase-missing': {
      const at = keyPlace === undefined ? 'privateKey' : `${keyPlace.keyPath}${lineOf(keyPlace)}`;
      const passphrase = variable === undefined ? 'SEALUP_PASSPHRASE' : `${variable}_PASSPHRASE`;
      return {
        title: `The private key in ${key} needs a passphrase.`,
        details: [
          `It is encrypted. Next to ${at}, add:`,
          `  passphrase: $\{${passphrase}}`,
          `and set ${passphrase} as you set ${variable ?? 'the key'}.`,
        ],
        state,
        slug,
      };
    }
    case 'passphrase-wrong': {
      const passphrase = target?.passphrase?.envName;
      return {
        title: `The passphrase in ${passphrase ?? 'passphrase'} does not open the private key in ${key}.`,
        details: [
          ...readsLine(target?.places.passphrase, passphrase, file),
          'Check that the two secrets belong together: the key file and its passphrase.',
        ],
        state,
        slug,
      };
    }
  }
}
