import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import * as oidc from 'openid-client';
import type { Config } from './config.ts';
import { Platform, PlatformError } from './platform.ts';
import {
  type LoginState,
  now,
  Sealer,
  type Session,
  token,
  type User,
  userIdFor,
} from './session.ts';

/** Fixed development accounts (DEV_AUTH, loopback only). */
export const DEV_ACCOUNTS = [
  { id: 'tim', name: 'Tim', email: 'tim@example.test' },
  { id: 'bob', name: 'Bob', email: 'bob@example.test' },
  { id: 'sally', name: 'Sally', email: 'sally@example.test' },
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 256 * 1024;
/** Open conversation streams one person may have at once; each keeps an agent awake. */
export const MAX_STREAMS_PER_USER = 8;

/**
 * Ends a relayed stream cleanly when the platform closes it (its proxy's idle
 * timeout, a restart): the browser sees the end and reconnects, and nothing is
 * logged as a crash. `onEnd` runs once, however the stream ends.
 */
export function tolerant(
  body: ReadableStream<Uint8Array>,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          end();
        } else {
          controller.enqueue(value);
        }
      } catch {
        controller.close();
        end();
      }
    },
    cancel() {
      end();
      return reader.cancel().catch(() => undefined);
    },
  });
}

type Env = { Variables: { session: Session } };

const fail = (c: Context, status: number, code: string, message: string) =>
  c.json({ error: { code, message } }, status as 400);

/** A same-site path to return to after sign-in, never another site. */
export function safeNext(value: string | undefined | null): string {
  return value?.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/';
}

export function createApp(config: Config, platform = new Platform(config)) {
  const app = new Hono<Env>();
  const secure = config.appUrl.protocol === 'https:';
  const sessionCookie = secure ? '__Host-pai_session' : 'pai_session';
  const loginCookie = secure ? '__Host-pai_login' : 'pai_login';
  const sessions = new Sealer(config.sessionSecret, 'session');
  const logins = new Sealer(config.sessionSecret, 'login');
  const appOrigin = config.appUrl.origin;

  let oidcConfig: Promise<oidc.Configuration> | null = null;
  const oidcClient = () => {
    if (!config.oidc) throw new Error('single sign-on is not configured');
    oidcConfig ??= oidc
      .discovery(config.oidc.issuer, config.oidc.clientId, config.oidc.clientSecret, undefined, {
        // https is required of the provider (see config.ts), except on loopback.
        execute: config.oidc.issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [],
      })
      .catch((error) => {
        oidcConfig = null; // try discovery again on the next sign-in
        throw error;
      });
    return oidcConfig;
  };

  const readSession = (c: Context): Session | null => {
    const session = sessions.open<Session>(getCookie(c, sessionCookie));
    return session && session.expiresAt > now() ? session : null;
  };

  const startSession = (c: Context, user: User) => {
    const session: Session = {
      user,
      csrf: token(),
      expiresAt: now() + config.sessionTtlSeconds,
    };
    setCookie(c, sessionCookie, sessions.seal(session), {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: config.sessionTtlSeconds,
    });
  };

  /** Writes come only from this app's own pages: same Origin, and the session's token. */
  const sameOrigin = (c: Context) => {
    const origin = c.req.header('Origin');
    return origin === undefined || origin === appOrigin;
  };

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const session = readSession(c);
    if (!session) return fail(c, 401, 'unauthorized', 'Sign in to continue');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (!sameOrigin(c) || c.req.header('X-CSRF-Token') !== session.csrf)
        return fail(
          c,
          403,
          'csrf_failed',
          'Invalid request token or origin. Reload the page and try again.',
        );
    }
    c.set('session', session);
    await next();
  };

  app.use('*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/api/') && !c.res.headers.has('Cache-Control'))
      c.header('Cache-Control', 'no-store');
    if (secure) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Frame-Options', 'DENY');
  });

  // ---- Health ---------------------------------------------------------------

  /** For a container's or a load balancer's health check: the server is up (it does not call the platform). */
  app.get('/healthz', (c) => c.json({ ok: true }));

  // ---- Sign-in ------------------------------------------------------------

  app.get('/api/auth/config', (c) =>
    c.json({
      data: {
        oidcEnabled: config.oidc !== null,
        devAuthEnabled: config.devAuth,
        devAccounts: config.devAuth ? DEV_ACCOUNTS : [],
        instance: {
          name: process.env.APP_NAME?.trim() || 'Pi Agents',
          logoUrl: null,
          orgName: '',
          supportUrl: null,
        },
      },
    }),
  );

  app.get('/api/me', (c) => {
    const session = readSession(c);
    if (!session) {
      if (c.req.query('optional') === 'true') return c.json({ data: null });
      return fail(c, 401, 'unauthorized', 'Sign in to continue');
    }
    return c.json({ data: { user: session.user, csrfToken: session.csrf } });
  });

  app.post('/auth/dev', async (c) => {
    if (!config.devAuth) return fail(c, 404, 'not_found', 'Not found');
    if (!sameOrigin(c)) return fail(c, 403, 'origin_denied', 'Development sign-in is local-only');
    const body = (await c.req.json().catch(() => ({}))) as { account?: unknown };
    const account = DEV_ACCOUNTS.find((candidate) => candidate.id === body.account);
    if (!account) return fail(c, 400, 'unknown_account', 'Unknown development account');
    startSession(c, { id: userIdFor('dev', account.id), name: account.name, email: account.email });
    return c.json({ data: { ok: true } });
  });

  app.get('/auth/login', async (c) => {
    if (!config.oidc) return fail(c, 404, 'not_found', 'Single sign-on is not configured');
    const client = await oidcClient();
    const verifier = oidc.randomPKCECodeVerifier();
    const state: LoginState = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier,
      next: safeNext(c.req.query('next')),
      expiresAt: now() + 600,
    };
    setCookie(c, loginCookie, logins.seal(state), {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    const target = oidc.buildAuthorizationUrl(client, {
      redirect_uri: new URL('/auth/callback', config.appUrl).href,
      scope: config.oidc.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: state.state,
      nonce: state.nonce,
    });
    return c.redirect(target.href);
  });

  app.get('/auth/callback', async (c) => {
    if (!config.oidc) return fail(c, 404, 'not_found', 'Single sign-on is not configured');
    const login = logins.open<LoginState>(getCookie(c, loginCookie));
    deleteCookie(c, loginCookie, { path: '/', secure });
    if (!login || login.expiresAt < now()) return c.redirect('/sign-in?error=expired');
    try {
      const client = await oidcClient();
      // The address the provider redirected to, as people reach this app.
      const current = new URL(`/auth/callback${new URL(c.req.url).search}`, config.appUrl);
      const tokens = await oidc.authorizationCodeGrant(client, current, {
        pkceCodeVerifier: login.verifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('no ID token claims');
      const email = typeof claims.email === 'string' ? claims.email : '';
      const name =
        (typeof claims.name === 'string' && claims.name) ||
        (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
        email;
      startSession(c, { id: userIdFor(claims.iss, claims.sub), name, email });
      return c.redirect(login.next);
    } catch (error) {
      console.error('[auth] sign-in failed', error);
      return c.redirect('/sign-in?error=failed');
    }
  });

  app.post('/auth/logout', (c) => {
    const session = readSession(c);
    if (session && (!sameOrigin(c) || c.req.header('X-CSRF-Token') !== session.csrf))
      return fail(c, 403, 'csrf_failed', 'Invalid request token or origin.');
    deleteCookie(c, sessionCookie, { path: '/', secure });
    return c.json({ data: { ok: true } });
  });

  // ---- Agents ---------------------------------------------------------------

  app.use('/api/agents', requireSession);
  app.use('/api/agents/*', requireSession);

  /** The platform said no to the service key: this app's configuration, not the person's session. */
  const platformFailure = (c: Context, error: unknown) => {
    if (error instanceof PlatformError) {
      if (error.status === 401 || error.status === 403) {
        console.error('[platform] the service key was refused', error.status, error.body);
        return fail(
          c,
          502,
          'platform_refused',
          "The agent platform refused this app's service key.",
        );
      }
      return new Response(error.body, {
        status: error.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[platform] request failed', error);
    return fail(c, 502, 'platform_unreachable', 'The agent platform could not be reached.');
  };

  /** The person's agents. For now one: their assistant, made on first use. */
  app.get('/api/agents', async (c) => {
    try {
      const agent = await platform.ensureAssistant(c.get('session').user);
      return c.json({ data: [{ ...agent, name: config.agentName }] });
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  /** Every route below names an agent; it must be the person's own. */
  app.use('/api/agents/:agentId/*', async (c, next) => {
    const agentId = c.req.param('agentId');
    if (!agentId || !UUID.test(agentId)) return fail(c, 404, 'not_found', 'Agent not found');
    try {
      if (!(await platform.isOwnAgent(c.get('session').user, agentId)))
        return fail(c, 404, 'not_found', 'Agent not found');
    } catch (error) {
      return platformFailure(c, error);
    }
    await next();
  });

  /** Relays one request to the agent on the platform, passing its answer through. */
  const relay = async (
    c: Context,
    path: string,
    init: RequestInit = {},
    /** For a stream: called once when it ends, however it ends. */
    onStreamEnd?: () => void,
  ) => {
    let upstream: Response;
    try {
      upstream = await platform.fetch(path, { ...init, signal: c.req.raw.signal });
    } catch (error) {
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      return platformFailure(c, error);
    }
    if (upstream.status === 401 || upstream.status === 403)
      return platformFailure(c, new PlatformError(upstream.status, await upstream.text()));
    const headers = new Headers();
    for (const name of ['Content-Type', 'Cache-Control', 'ETag']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (headers.get('Content-Type')?.startsWith('text/event-stream')) {
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Accel-Buffering', 'no'); // no buffering in reverse proxies
      if (upstream.body)
        return new Response(tolerant(upstream.body, onStreamEnd ?? (() => undefined)), {
          status: upstream.status,
          headers,
        });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  };

  const agentPath = (c: Context, rest = '') =>
    `/v1/agents/${encodeURIComponent(c.req.param('agentId')!)}${rest}`;
  const threadPath = (c: Context, rest = '') => {
    const threadId = c.req.param('threadId') ?? '';
    if (!THREAD_ID.test(threadId))
      throw new HTTPException(400, {
        res: Response.json(
          {
            error: {
              code: 'invalid_thread_id',
              message: 'Thread IDs are 1-64 letters, digits, dashes or underscores',
            },
          },
          { status: 400 },
        ),
      });
    return agentPath(c, `/threads/${threadId}${rest}`);
  };

  const readBody = async (c: Context): Promise<string | Response> => {
    const length = Number(c.req.header('Content-Length') ?? 0);
    if (length > MAX_BODY_BYTES) return fail(c, 413, 'too_large', 'Request body too large');
    const body = await c.req.text();
    if (body.length > MAX_BODY_BYTES) return fail(c, 413, 'too_large', 'Request body too large');
    return body;
  };

  app.get('/api/agents/:agentId/threads', (c) => relay(c, agentPath(c, '/threads')));
  app.get('/api/agents/:agentId/threads/:threadId', (c) => relay(c, threadPath(c)));
  app.delete('/api/agents/:agentId/threads/:threadId', (c) =>
    relay(c, threadPath(c), { method: 'DELETE' }),
  );
  app.post('/api/agents/:agentId/threads/:threadId/messages', async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    return relay(c, threadPath(c, '/messages'), { method: 'POST', body });
  });
  app.post('/api/agents/:agentId/threads/:threadId/stop', (c) =>
    relay(c, threadPath(c, '/stop'), { method: 'POST' }),
  );
  const streams = new Map<string, number>();
  app.get('/api/agents/:agentId/threads/:threadId/events', async (c) => {
    const path = threadPath(c, '/events');
    const userId = c.get('session').user.id;
    const open = streams.get(userId) ?? 0;
    if (open >= MAX_STREAMS_PER_USER)
      return fail(
        c,
        429,
        'too_many_streams',
        'Too many conversations are open at once. Close some and try again.',
      );
    streams.set(userId, open + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (streams.get(userId) ?? 1) - 1;
      if (left <= 0) streams.delete(userId);
      else streams.set(userId, left);
    };
    const response = await relay(c, path, { headers: { Accept: 'text/event-stream' } }, release);
    // Anything that is not a stream (an error, a refusal) holds nothing open.
    if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) release();
    return response;
  });

  app.all('/api/*', (c) => fail(c, 404, 'not_found', 'Not found'));

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error('[server] unhandled', error);
    return fail(c, 500, 'internal', 'Internal error');
  });

  return app;
}
