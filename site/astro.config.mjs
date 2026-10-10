// The docs site at sealup.dev (decision 0036, spec sealup/sealup#41 decisions 40-42). Every
// `sealup.dev` link the CLI prints has its page here; `npm run check` proves it on the build.

import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://sealup.dev',
  // `/e/<slug>/` and `/deploy/` are folders with an index.html: the links the CLI prints
  // (`sealup.dev/e/login-refused`) open them as they are.
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'sealup',
      description: 'Fast, safe deploys to shared hosting over SFTP, SSH or FTP.',
      logo: {
        light: './src/assets/sealup-wordmark.svg',
        dark: './src/assets/sealup-wordmark-on-dark.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sealup/sealup' }],
      customCss: ['./src/styles/fonts.css', './src/styles/brand.css'],
      sidebar: [
        {
          label: 'Start here',
          items: ['getting-started', 'ovh'],
        },
        {
          label: 'Protocols',
          items: ['sftp', 'ssh', 'ftps', 'ftp', 'private-keys'],
        },
        {
          label: 'Deploys',
          items: ['mirror', 'check-server', 'lock', 'allow', 'github-action'],
        },
        {
          label: 'Commands',
          items: ['init', 'deploy', 'pull', 'keyscan', 'check'],
        },
        {
          label: 'Reference',
          items: ['config', 'exit-codes', 'security'],
        },
        {
          label: 'Errors',
          collapsed: true,
          items: [{ autogenerate: { directory: 'e' } }],
        },
      ],
    }),
  ],
});
