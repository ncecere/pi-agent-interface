import type { components } from './schema.gen';

/**
 * This app's own server (server/), same origin. It signs people in and talks
 * to pi-durable-platform for them with the team's service account; the
 * browser never reaches the platform. Agent and conversation shapes are the
 * platform's, passed through unchanged (types from its OpenAPI: `pnpm gen:api`).
 */
type Schemas = components['schemas'];
/** A platform agent as this app lists it: with the app's own name for it and its kind. */
export type Agent = Schemas['Agent'] & {
  /**
   * provided: every person gets their own copy (Admin → Agents); personal: the
   * person's own; team: an agent of a shared team they belong to (Connect).
   */
  kind?: 'provided' | 'personal' | 'team';
  /** For team agents: the team's name, to group them by. */
  teamName?: string;
};
export type AgentThread = Schemas['AgentThread'];
export type ChatView = Schemas['ChatView'];
export type ChatViewMessage = Schemas['ChatMessage'];

export type Role = 'admin' | 'user';

/** Optional features (server/features.ts) and whether each is on. */
export type FeatureId = 'usage' | 'myUsage';

export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  csrfToken: string;
  features?: Partial<Record<FeatureId, boolean>>;
  /**
   * How the app reaches the person's agents. `connect`: they connect their own
   * platform account (`account` null until they do); `service`: nothing to do.
   */
  platform?: {
    mode: 'connect' | 'service';
    account: { email: string | null; name: string | null; since: string } | null;
  };
}

export interface AuthConfig {
  oidcEnabled: boolean;
  devAuthEnabled: boolean;
  devAccounts: { id: string; name: string; email: string }[];
  instance: {
    name: string;
    logoUrl: string | null;
    colorTheme: 'neutral' | 'blue' | 'violet' | 'emerald';
    defaultTheme: 'light' | 'dark' | 'system';
    orgName: string;
    supportUrl: string | null;
  };
}

/** An error response: `{"error": {"code", "message"}}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// The session's CSRF token, from GET /api/me. Sent on every write.
let csrfToken = '';
export function setCsrfToken(token: string) {
  csrfToken = token;
}

const sessionEndedListeners = new Set<() => void>();
/** Called when a request that had a session gets 401: it has ended (signed out, expired). */
export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}
const notConnectedListeners = new Set<() => void>();
/** Called when the server says the person's platform connection is missing or has ended (Connect mode). */
export function onNotConnected(listener: () => void): () => void {
  notConnectedListeners.add(listener);
  return () => notConnectedListeners.delete(listener);
}

export function noteUnauthorized() {
  if (!csrfToken) return;
  setCsrfToken('');
  for (const listener of sessionEndedListeners) listener();
}

export function apiErrorFrom(response: Response, body: unknown): ApiError {
  const err = (body ?? {}) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
  return new ApiError(
    response.status,
    err.error?.code ?? `http_${response.status}`,
    err.error?.message ?? `Request failed (${response.status})`,
    err.error?.details,
  );
}

/** A request to this app's server; the `data` of the answer, or throws an ApiError. */
export async function request<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // An empty or non-JSON answer: the status says enough.
  }
  if (!response.ok) {
    const error = apiErrorFrom(response, parsed);
    if (response.status === 401) noteUnauthorized();
    if (error.code === 'not_connected') for (const listener of notConnectedListeners) listener();
    // Suspended while signed in: the session is over, and sign-in says why.
    if (error.code === 'suspended' && window.location.pathname !== '/sign-in')
      window.location.assign('/sign-in?error=suspended');
    throw error;
  }
  return (parsed as { data: T } | null)?.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** `/api/agents/{agentId}…`, with each part encoded. */
export const agentPath = (agentId: string, rest = '') =>
  `/api/agents/${encodeURIComponent(agentId)}${rest}`;
export const threadPath = (agentId: string, threadId: string, rest = '') =>
  agentPath(agentId, `/threads/${encodeURIComponent(threadId)}${rest}`);

/** A message suitable to show for a failed request. */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'The connection to the server was lost.';
  return fallback;
}
