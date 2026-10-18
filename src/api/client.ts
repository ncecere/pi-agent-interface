import type { components } from './schema.gen';

/**
 * This app's own server (server/), same origin. It signs people in and talks
 * to pi-durable-platform for them with the team's service account; the
 * browser never reaches the platform. Agent and conversation shapes are the
 * platform's, passed through unchanged (types from its OpenAPI: `pnpm gen:api`).
 */
type Schemas = components['schemas'];
export type Agent = Schemas['Agent'];
export type AgentThread = Schemas['AgentThread'];
export type ChatView = Schemas['ChatView'];
export type ChatViewMessage = Schemas['ChatMessage'];

export type Role = 'admin' | 'user';

export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  csrfToken: string;
}

export interface AuthConfig {
  oidcEnabled: boolean;
  devAuthEnabled: boolean;
  devAccounts: { id: string; name: string; email: string }[];
  instance: { name: string; logoUrl: string | null; orgName: string; supportUrl: string | null };
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
