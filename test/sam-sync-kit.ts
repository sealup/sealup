// A synthetic sam-sync project for the conversion's tests (#37, S03): the CLI page's "Before:
// sam-sync" (reference.js), with verbose and dry as S03's screen says, in sam-sync's own format
// (its published package, sam-sync 1.1.1 on npm). Never an owner's project. The password is the
// canary password and api/.env.prod the multi-line canary, so the leak tests look for both.

import { canaries } from '../src/testkit/index.ts';

const login = {
  type: 'sftp',
  host: 'ssh.example.com',
  port: 22,
  user: 'deploy',
  password: canaries.SEALUP_CANARY_PASSWORD,
};

/** S03's `.deployment.json`. */
export const samSyncDeployment = {
  ...login,
  verbose: true,
  dry: false,
  localPrefix: './',
  remotePrefix: '/home/site/',
  up: {
    directories: [
      { source: 'public_html/', destin: 'www/', excludes: ['/resources'] },
      { source: 'api/', excludes: ['/.env', '/.env.prod', '/storage'] },
    ],
    files: [{ source: 'api/.env.prod', destin: 'api/.env' }],
  },
};

/** S03's `.download.json`: the same server. */
export const samSyncDownload = {
  ...login,
  localPrefix: './',
  remotePrefix: '/home/site/',
  down: { directories: [{ source: 'www/resources/', destin: 'public_html/resources/' }] },
};

const packageJson = {
  scripts: {
    build: 'ng build',
    deploy: 'npm run build && npx sam-sync .deployment.json',
    download: 'npx sam-sync .download.json',
  },
};

/** The project's files, by `/`-separated path (for newProject); `download: null` for none. */
export function samSyncProject(
  deployment: unknown = samSyncDeployment,
  download: unknown = samSyncDownload,
): Record<string, string> {
  return {
    '.deployment.json': JSON.stringify(deployment, null, 2),
    ...(download === null ? {} : { '.download.json': JSON.stringify(download, null, 2) }),
    'package.json': JSON.stringify(packageJson, null, 2),
    'package-lock.json': '{}',
    '.gitignore': 'node_modules\n',
    'public_html/index.html': '<h1>home</h1>',
    'public_html/resources/photo.jpg': 'jpg',
    'api/index.php': '<?php',
    'api/.env': 'APP_ENV=local\n',
    'api/.env.prod': canaries.SEALUP_CANARY_MULTILINE,
    'api/storage/log.txt': 'log',
  };
}
