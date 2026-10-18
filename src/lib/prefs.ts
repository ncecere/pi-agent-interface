import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '~/api/client';
import { AVATAR_STYLES, type AvatarStyle } from '~/components/agent/avatar/avatar-art';
import { setAvatarStyle, useAvatarStyle } from '~/components/agent/avatar/avatar-prefs';
import { useCurrentUser } from '~/hooks/use-session';
import { useTheme } from '~/providers/theme-provider';
import { COLOR_THEMES, type ColorTheme, THEME_MODES, type ThemeMode } from '~/shared';

/**
 * A person's appearance, saved on the server so it follows them between
 * devices. Each browser also keeps its own copy (localStorage) so the first
 * paint is right before the server answers.
 */
export interface Appearance {
  theme: ThemeMode;
  colorTheme: ColorTheme;
  codeWrap: boolean;
  invertSend: boolean;
  avatarStyle: AvatarStyle;
}

export const PREFS_KEY = ['prefs'] as const;

/** Reads a saved appearance, keeping only what is valid (a field from an older or newer version is ignored). */
export function parseAppearance(value: unknown): Partial<Appearance> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<Appearance> = {};
  if (THEME_MODES.includes(raw.theme as ThemeMode)) out.theme = raw.theme as ThemeMode;
  if (COLOR_THEMES.includes(raw.colorTheme as ColorTheme))
    out.colorTheme = raw.colorTheme as ColorTheme;
  if (typeof raw.codeWrap === 'boolean') out.codeWrap = raw.codeWrap;
  if (typeof raw.invertSend === 'boolean') out.invertSend = raw.invertSend;
  if (AVATAR_STYLES.some((style) => style.id === raw.avatarStyle))
    out.avatarStyle = raw.avatarStyle as AvatarStyle;
  return out;
}

export function usePrefs() {
  const me = useCurrentUser();
  return useQuery({
    queryKey: [...PREFS_KEY, me?.user.id],
    queryFn: () => api.get<Record<string, unknown>>('/api/me/prefs'),
    enabled: Boolean(me),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Keeps this browser's appearance and the server's in step: the saved one is
 * applied once it arrives, and every change after that is saved. Mounted once
 * for a signed-in person.
 */
export function AppearanceSync() {
  const { data } = usePrefs();
  const theme = useTheme();
  const avatarStyle = useAvatarStyle();
  const applied = useRef(false);
  const lastSaved = useRef<string | null>(null);

  const current: Appearance = {
    theme: theme.theme,
    colorTheme: theme.colorTheme,
    codeWrap: theme.codeWrap,
    invertSend: theme.invertSend,
    avatarStyle,
  };
  const json = JSON.stringify(current);

  useEffect(() => {
    if (!data || applied.current) return;
    applied.current = true;
    const saved = parseAppearance(data.appearance);
    if (Object.keys(saved).length === 0) return; // nothing saved yet: this browser's choices are saved below
    const next = { ...current, ...saved };
    lastSaved.current = JSON.stringify(next);
    if (saved.theme) theme.setTheme(saved.theme);
    if (saved.colorTheme) theme.setColorTheme(saved.colorTheme);
    if (saved.codeWrap !== undefined) theme.setCodeWrap(saved.codeWrap);
    if (saved.invertSend !== undefined) theme.setInvertSend(saved.invertSend);
    if (saved.avatarStyle) setAvatarStyle(saved.avatarStyle);
  });

  useEffect(() => {
    if (!applied.current || json === lastSaved.current) return;
    // A burst of changes (clicking through themes) is saved once.
    const timer = setTimeout(() => {
      lastSaved.current = json;
      void api.put('/api/me/prefs/appearance', { value: JSON.parse(json) }).catch(() => {
        lastSaved.current = null; // try again on the next change
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [json]);

  return null;
}
