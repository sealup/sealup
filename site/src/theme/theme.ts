// The theme switch's rules (plan 06 ruling 4), pure so Node tests them as they are. The choice
// lives where Starlight keeps its own: `light` or `dark` under `starlight-theme`; nothing stored
// (or Starlight's empty "auto") follows the system. Starlight's head script, the home page's and
// the switch all read that one value.

/** A theme a page shows. */
export type Theme = 'light' | 'dark';

/** Starlight's key in `localStorage` (@astrojs/starlight 0.42.5, ThemeSelect.astro). */
export const storageKey = 'starlight-theme';

/** The theme a stored value names; anything but light or dark is no choice: the system's. */
export function readTheme(stored: string | null): Theme | undefined {
  return stored === 'light' || stored === 'dark' ? stored : undefined;
}

/** The theme a page shows: the stored one, else the system's. */
export function shownTheme(stored: Theme | undefined, prefersLight: boolean): Theme {
  return stored ?? (prefersLight ? 'light' : 'dark');
}

/** The theme a click on the switch goes to. */
export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/** The switch's accessible name while `theme` shows: what a click does. */
export function switchLabel(theme: Theme): string {
  return `Switch to ${otherTheme(theme)} theme`;
}
