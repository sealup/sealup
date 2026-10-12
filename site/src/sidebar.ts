// The docs' sidebar, as Starlight takes it (astro.config.mjs): a module of its own so the site's
// tests can hold every page to it (test/sidebar.test.ts).

/** A sidebar entry: a page's slug, or a folder whose pages fill the group by themselves. */
type Item = string | { readonly autogenerate: { readonly directory: string } };

interface Group {
  readonly label: string;
  readonly collapsed?: boolean;
  readonly items: Item[];
}

export const sidebar: Group[] = [
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
    items: ['mirror', 'write', 'check-server', 'lock', 'allow', 'github-action'],
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
];

/** The slugs no group lists, by name or by a folder it fills itself with, in the order given. */
export function pagesOutsideSidebar(
  slugs: readonly string[],
  groups: readonly { readonly items: readonly Item[] }[],
): string[] {
  const items = groups.flatMap((group) => group.items);
  return slugs.filter(
    (slug) =>
      !items.some((item) =>
        typeof item === 'string' ? item === slug : slug.startsWith(`${item.autogenerate.directory}/`),
      ),
  );
}
