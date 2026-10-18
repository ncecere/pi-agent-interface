import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type AuthConfig,
  api,
  type Me,
  noteUnauthorized,
  setCsrfToken,
  unwrap,
} from '~/api/client';

export const ME_KEY = ['me'] as const;
export const AUTH_CONFIG_KEY = ['auth-config'] as const;

/** The signed-in user (and the CSRF token for writes), or null when signed out. */
export async function fetchMe(): Promise<Me | null> {
  try {
    // optional: signed out is `data: null`, not a 401.
    const me = unwrap(await api.GET('/v1/me', { params: { query: { optional: true } } }));
    if (!me) return null;
    setCsrfToken(me.csrfToken);
    return me;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** The session this tab last confirmed; null once it is known to have ended. */
let confirmed: Me | null = null;

/**
 * For route guards: the session, read before render. A failure other than
 * "signed out" (the platform restarting) keeps the session last confirmed, so
 * navigation inside a signed-in app carries on; only a first load fails.
 */
export async function loadSession(): Promise<Me | null> {
  try {
    confirmed = await fetchMe();
    return confirmed;
  } catch (error) {
    if (confirmed) return confirmed;
    throw error;
  }
}

export function forgetSession() {
  confirmed = null;
}

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
  });
}

/** The signed-in user; only below the authenticated route. */
export function useCurrentUser(): Me | undefined {
  return useMe().data ?? undefined;
}

export function useAuthConfig() {
  return useQuery<AuthConfig>({
    queryKey: AUTH_CONFIG_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/auth/config')),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.POST('/auth/logout');
    },
    onSettled: () => {
      forgetSession();
      noteUnauthorized();
      setCsrfToken('');
      queryClient.clear();
      window.location.assign('/sign-in');
    },
  });
}

/** Development sign-in as one of the platform's DEV_AUTH personas. */
export function useDevSignIn() {
  return useMutation({
    mutationFn: async (account: string) =>
      unwrap(await api.POST('/auth/dev', { body: { account } })),
  });
}

/** A same-site path from ?next= (never another site), or undefined. */
export function nextPath(search: string): string | undefined {
  const next = new URLSearchParams(search).get('next');
  return next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : undefined;
}
