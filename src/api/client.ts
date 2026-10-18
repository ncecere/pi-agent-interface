import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema.gen';

/**
 * The pi-durable-platform API, same origin. In development Vite proxies /v1
 * and /auth to the platform (vite.config.ts); in production the platform or a
 * reverse proxy serves this UI beside them. Types come from the platform's
 * OpenAPI document: `pnpm gen:api`.
 */
export type Schemas = components['schemas'];
export type Agent = Schemas['Agent'];
export type AgentThread = Schemas['AgentThread'];
export type ChatView = Schemas['ChatView'];
export type ChatViewMessage = Schemas['ChatMessage'];
export type Me = Schemas['Me'];
export type AuthConfig = Schemas['AuthConfig'];

/** An error response from the platform: `{"error": {"code", "message"}}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Seconds from Retry-After (429 rate_limited). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// The session's CSRF token, from GET /v1/me. Sent on every unsafe request.
let csrfToken = '';
export function setCsrfToken(token: string) {
  csrfToken = token;
}

/** The CSRF header for unsafe requests made without the typed client. */
export function csrfHeader(): Record<string, string> {
  return csrfToken ? { 'X-CSRF-Token': csrfToken } : {};
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

const middleware: Middleware = {
  onRequest({ request }) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && csrfToken) {
      request.headers.set('X-CSRF-Token', csrfToken);
    }
    return request;
  },
  onResponse({ response }) {
    if (response.status === 401) noteUnauthorized();
    return response;
  },
};

export const api = createClient<paths>({
  baseUrl: globalThis.location?.origin ?? '',
  credentials: 'same-origin',
  // Looked up per call so tests can replace fetch.
  fetch: (request) => globalThis.fetch(request),
});
api.use(middleware);

type Result<T> = { data?: { data: T }; error?: unknown; response: Response };

/** The `data` of a successful response, or throws an ApiError. */
export function unwrap<T>(res: Result<T>): T {
  if (res.data !== undefined) return res.data.data;
  throw apiErrorFrom(res.response, res.error);
}

export function apiErrorFrom(response: Response, body: unknown): ApiError {
  const err = (body ?? {}) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
  const retry = Number(response.headers?.get('Retry-After'));
  return new ApiError(
    response.status,
    err.error?.code ?? `http_${response.status}`,
    err.error?.message ?? `Request failed (${response.status})`,
    err.error?.details,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}

/** A message suitable to show for a failed request. */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'The connection to the server was lost.';
  return fallback;
}
