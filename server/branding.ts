/**
 * How this instance presents itself: its name, its logo, and the look people
 * start with (they can change their own in Settings). Administrators edit it;
 * every page, the sign-in page included, reads it.
 */
export const COLOR_THEMES = ['neutral', 'blue', 'violet', 'emerald'] as const;
export const THEME_MODES = ['light', 'dark', 'system'] as const;

export interface Branding {
  name: string;
  /** https, or a path on this site. Null: the built-in mark. */
  logoUrl: string | null;
  colorTheme: (typeof COLOR_THEMES)[number];
  defaultTheme: (typeof THEME_MODES)[number];
}

export const defaultBranding = (name = 'Pi Agent Interface'): Branding => ({
  name,
  logoUrl: null,
  colorTheme: 'neutral',
  defaultTheme: 'dark',
});

export const MAX_NAME = 60;

/** A logo address the browser may load: https without credentials, or a path on this site. */
export function isSafeLogoUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Validates an edit; returns the branding to save, or the problems (by field). */
export function parseBranding(
  input: unknown,
): { branding: Branding } | { problems: Record<string, string> } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const problems: Record<string, string> = {};
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) problems.name = 'Give the app a name.';
  else if (name.length > MAX_NAME) problems.name = `At most ${MAX_NAME} characters.`;
  let logoUrl: string | null = null;
  if (typeof raw.logoUrl === 'string' && raw.logoUrl.trim()) {
    logoUrl = raw.logoUrl.trim();
    if (logoUrl.length > 2000 || !isSafeLogoUrl(logoUrl))
      problems.logoUrl = 'Use an https address, or a path on this site such as /logo.svg.';
  }
  const colorTheme = COLOR_THEMES.find((theme) => theme === raw.colorTheme);
  if (!colorTheme) problems.colorTheme = 'Choose one of the accents.';
  const defaultTheme = THEME_MODES.find((theme) => theme === raw.defaultTheme);
  if (!defaultTheme) problems.defaultTheme = 'Choose light, dark or system.';
  if (Object.keys(problems).length || !colorTheme || !defaultTheme) return { problems };
  return { branding: { name, logoUrl, colorTheme, defaultTheme } };
}
