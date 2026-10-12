// The docs site at sealup.dev (decision 0036, spec sealup/sealup#41 decisions 40-42). Every
// `sealup.dev` link the CLI prints has its page here; `npm run check` proves it on the build.

import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { sidebar } from './src/sidebar.ts';

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
      // The theme switch, one button shared with the home page (plan 06 ruling 4).
      components: { ThemeSelect: './src/components/ThemeSwitch.astro' },
      customCss: ['./src/styles/fonts.css', './src/styles/brand.css'],
      sidebar,
    }),
  ],
});
