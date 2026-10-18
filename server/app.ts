import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import * as oidc from 'openid-client';
import {
  type AgentSettings,
  ASSISTANT_ID,
  defaultAgentSettings,
  defaultProvided,
  keys,
  kindOfKey,
  type ProvidedAgent,
  parseAgentSettings,
  parseProvided,
} from './agent-settings.ts';
import { type Branding, defaultBranding, parseBranding } from './branding.ts';
import type { Config } from './config.ts';
import { EventsHub } from './events-hub.ts';
import { Platform, type PlatformAgent, PlatformError } from './platform.ts';
import {
  type LoginState,
  now,
  Sealer,
  type Session,
  token,
  type User,
  userIdFor,
} from './session.ts';
import {
  type Person,
  PREF_LIMITS,
  type Role,
  type Status,
  type Store,
  StoreError,
} from './store.ts';

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
/** Event streams one person may hold: one per open tab. */
export const MAX_EVENT_STREAMS_PER_USER = 6;
/** A comment on the event stream this often keeps proxies from closing it as idle. */
const KEEP_ALIVE_MS = 15_000;

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

type Env = { Variables: { session: Session; person: Person } };

/** How long a person's record is trusted before it is read again (role, suspension, sign-out everywhere). */
const PERSON_TTL_MS = 10_000;

const fail = (c: Context, status: number, code: string, message: string) =>
  c.json({ error: { code, message } }, status as 400);

/** A same-site path to return to after sign-in, never another site. */
export function safeNext(value: string | undefined | null): string {
  return value?.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/';
}

export function createApp(
  config: Config,
  deps: { store: Store; platform?: Platform; events?: EventsHub },
) {
  const { store } = deps;
  const platform = deps.platform ?? new Platform(config);
  const events = deps.events ?? new EventsHub(platform);
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

  const startSession = (c: Context, person: Person) => {
    const user: User = { id: person.id, name: person.name, email: person.email };
    const session: Session = {
      user,
      csrf: token(),
      expiresAt: now() + config.sessionTtlSeconds,
      v: person.sessionVersion,
    };
    people.set(person.id, { person, at: Date.now() });
    setCookie(c, sessionCookie, sessions.seal(session), {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: config.sessionTtlSeconds,
    });
  };

  // The people behind sessions, read again every few seconds so a change of role,
  // a suspension or "sign out everywhere" takes effect without a database read on every request.
  const people = new Map<string, { person: Person | null; at: number }>();
  const personFor = async (id: string): Promise<Person | null> => {
    const known = people.get(id);
    if (known && Date.now() - known.at < PERSON_TTL_MS) return known.person;
    const person = await store.person(id);
    people.set(id, { person, at: Date.now() });
    return person;
  };
  const forget = (id: string) => people.delete(id);

  /** The signed-in person, or why there is none. A suspended person or an ended session is signed out. */
  const current = async (
    c: Context,
  ): Promise<
    { session: Session; person: Person } | { status: 401 | 403; code: string; message: string }
  > => {
    const session = readSession(c);
    if (!session) return { status: 401, code: 'unauthorized', message: 'Sign in to continue' };
    const person = await personFor(session.user.id);
    if (!person || person.sessionVersion !== session.v) {
      deleteCookie(c, sessionCookie, { path: '/', secure });
      return {
        status: 401,
        code: 'unauthorized',
        message: 'Your session has ended. Sign in again.',
      };
    }
    if (person.status === 'suspended') {
      deleteCookie(c, sessionCookie, { path: '/', secure });
      return {
        status: 403,
        code: 'suspended',
        message: 'Your account is suspended. Ask an administrator.',
      };
    }
    return { session, person };
  };

  /** Writes come only from this app's own pages: same Origin, and the session's token. */
  const sameOrigin = (c: Context) => {
    const origin = c.req.header('Origin');
    return origin === undefined || origin === appOrigin;
  };

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const found = await current(c);
    if (!('session' in found)) return fail(c, found.status, found.code, found.message);
    const { session, person } = found;
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
    c.set('person', person);
    await next();
  };

  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('person').role !== 'admin') return fail(c, 403, 'forbidden', 'Administrators only');
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

  /** Ready for traffic: the database answers. */
  app.get('/readyz', async (c) => {
    try {
      await store.person('readyz');
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // ---- Sign-in ------------------------------------------------------------

  // The instance's branding, read again at most every 30 seconds.
  let brandingCache: { value: Branding; at: number } | null = null;
  const branding = async (): Promise<Branding> => {
    if (brandingCache && Date.now() - brandingCache.at < 30_000) return brandingCache.value;
    const fallback = defaultBranding(process.env.APP_NAME?.trim() || undefined);
    const saved = parseBranding({
      ...fallback,
      ...((await store.setting('branding')) as object | null),
    });
    const value = 'branding' in saved ? saved.branding : fallback;
    brandingCache = { value, at: Date.now() };
    return value;
  };

  app.get('/api/auth/config', async (c) => {
    const brand = await branding();
    return c.json({
      data: {
        oidcEnabled: config.oidc !== null,
        devAuthEnabled: config.devAuth,
        devAccounts: config.devAuth ? DEV_ACCOUNTS : [],
        instance: {
          name: brand.name,
          logoUrl: brand.logoUrl,
          colorTheme: brand.colorTheme,
          defaultTheme: brand.defaultTheme,
          orgName: '',
          supportUrl: null,
        },
      },
    });
  });

  app.get('/api/me', async (c) => {
    const found = await current(c);
    if (!('session' in found)) {
      if (found.status === 401 && c.req.query('optional') === 'true') return c.json({ data: null });
      return fail(c, found.status, found.code, found.message);
    }
    const { session, person } = found;
    return c.json({
      data: {
        user: { id: person.id, name: person.name, email: person.email, role: person.role },
        csrfToken: session.csrf,
      },
    });
  });

  /** The signed-in person's saved preferences (appearance, inbox…), so they follow them between devices. */
  app.get('/api/me/prefs', requireSession, async (c) =>
    c.json({ data: await store.prefs(c.get('person').id) }),
  );

  app.put('/api/me/prefs/:key', requireSession, async (c) => {
    const key = c.req.param('key');
    const limit = PREF_LIMITS[key];
    if (limit === undefined) return fail(c, 404, 'unknown_pref', 'Unknown preference');
    const text = await c.req.text();
    if (text.length > limit + 64) return fail(c, 413, 'too_large', 'Preference too large');
    let body: { value?: unknown };
    try {
      body = JSON.parse(text) as { value?: unknown };
    } catch {
      return fail(c, 400, 'invalid_json', 'invalid JSON');
    }
    if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value))
      return fail(c, 400, 'invalid_value', 'value must be an object');
    await store.setPref(c.get('person').id, key, body.value);
    return c.json({ data: { ok: true } });
  });

  /** Ends every session of the signed-in person, this one included. */
  app.post('/api/me/sign-out-everywhere', requireSession, async (c) => {
    const person = c.get('person');
    await store.endSessions(person.id, person.id);
    forget(person.id);
    deleteCookie(c, sessionCookie, { path: '/', secure });
    return c.json({ data: { ok: true } });
  });

  app.post('/auth/dev', async (c) => {
    if (!config.devAuth) return fail(c, 404, 'not_found', 'Not found');
    if (!sameOrigin(c)) return fail(c, 403, 'origin_denied', 'Development sign-in is local-only');
    const body = (await c.req.json().catch(() => ({}))) as { account?: unknown };
    const account = DEV_ACCOUNTS.find((candidate) => candidate.id === body.account);
    if (!account) return fail(c, 400, 'unknown_account', 'Unknown development account');
    const person = await store.signIn(
      { id: userIdFor('dev', account.id), name: account.name, email: account.email },
      config.initialAdminEmail,
    );
    if (person.status === 'suspended')
      return fail(c, 403, 'suspended', 'Your account is suspended. Ask an administrator.');
    startSession(c, person);
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
      const person = await store.signIn(
        { id: userIdFor(claims.iss, claims.sub), name, email },
        config.initialAdminEmail,
      );
      if (person.status === 'suspended') return c.redirect('/sign-in?error=suspended');
      startSession(c, person);
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

  // ---- Administration -------------------------------------------------------

  app.use('/api/admin/*', requireSession, requireAdmin);

  const personView = (person: Person) => ({
    id: person.id,
    email: person.email,
    name: person.name,
    role: person.role,
    status: person.status,
    createdAt: person.createdAt.toISOString(),
    lastSeenAt: person.lastSeenAt?.toISOString() ?? null,
  });

  app.get('/api/admin/people', async (c) => {
    const people = await store.people(c.req.query('search') ?? undefined);
    return c.json({ data: people.map(personView) });
  });

  app.patch('/api/admin/people/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown; status?: unknown };
    const change: { role?: Role; status?: Status } = {};
    if (body.role !== undefined) {
      if (body.role !== 'admin' && body.role !== 'user')
        return fail(c, 400, 'invalid_role', 'role is admin or user');
      change.role = body.role;
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'suspended')
        return fail(c, 400, 'invalid_status', 'status is active or suspended');
      change.status = body.status;
    }
    const actor = c.get('person');
    if (id === actor.id && change.status === 'suspended')
      return fail(c, 400, 'self_suspend', "You can't suspend yourself.");
    try {
      const person = await store.updatePerson(id, change, actor.id);
      forget(id);
      return c.json({ data: personView(person) });
    } catch (error) {
      if (error instanceof StoreError)
        return fail(c, error.code === 'not_found' ? 404 : 409, error.code, error.message);
      throw error;
    }
  });

  app.get('/api/admin/overview', async (c) => {
    const everyone = await store.people();
    const day = 24 * 60 * 60 * 1000;
    const since = (days: number) => Date.now() - days * day;
    return c.json({
      data: {
        people: everyone.length,
        admins: everyone.filter((person) => person.role === 'admin' && person.status === 'active')
          .length,
        suspended: everyone.filter((person) => person.status === 'suspended').length,
        activeToday: everyone.filter((person) => (person.lastSeenAt?.getTime() ?? 0) > since(1))
          .length,
        activeThisWeek: everyone.filter((person) => (person.lastSeenAt?.getTime() ?? 0) > since(7))
          .length,
        newThisMonth: everyone.filter((person) => person.createdAt.getTime() > since(30)).length,
      },
    });
  });

  app.get('/api/admin/settings/branding', async (c) => c.json({ data: await branding() }));

  app.put('/api/admin/settings/branding', async (c) => {
    const parsed = parseBranding(await c.req.json().catch(() => null));
    if ('problems' in parsed)
      return c.json(
        {
          error: {
            code: 'invalid',
            message: 'Check the highlighted fields.',
            details: parsed.problems,
          },
        },
        400,
      );
    await store.setSetting('branding', parsed.branding, c.get('person').id);
    brandingCache = null;
    return c.json({ data: parsed.branding });
  });

  /** Everything Admin → Agents shows: the settings, the provided agents, and what the platform offers. */
  app.get('/api/admin/agents', async (c) => {
    try {
      const [settings, provided, available] = await Promise.all([
        agentSettings(),
        providedAgents(),
        offered(),
      ]);
      return c.json({
        data: {
          settings,
          provided,
          models: available.models.map(({ id, name }) => ({ id, name })),
          templates: available.templates.map(({ id, name, description, teamId }) => ({
            id,
            name,
            description: description ?? '',
            team: Boolean(teamId),
          })),
          environmentModel: config.agentModel || null,
        },
      });
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  const invalid = (c: Context, problems: Record<string, string>) =>
    c.json(
      { error: { code: 'invalid', message: 'Check the highlighted fields.', details: problems } },
      400,
    );

  app.put('/api/admin/settings/agents', async (c) => {
    try {
      const parsed = parseAgentSettings(await c.req.json().catch(() => null), await offered());
      if ('problems' in parsed) return invalid(c, parsed.problems);
      await store.setSetting('agents', parsed.value, c.get('person').id);
      return c.json({ data: parsed.value });
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  app.put('/api/admin/settings/provided', async (c) => {
    try {
      const parsed = parseProvided(await c.req.json().catch(() => null), await offered());
      if ('problems' in parsed) return invalid(c, parsed.problems);
      // The built-in assistant stays first.
      const value = [
        ...parsed.value.filter((agent) => agent.id === ASSISTANT_ID),
        ...parsed.value.filter((agent) => agent.id !== ASSISTANT_ID),
      ];
      await store.setSetting('provided', { agents: value }, c.get('person').id);
      return c.json({ data: value });
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  app.get('/api/admin/audit', async (c) => {
    const entries = await store.audit(Number(c.req.query('limit') ?? 100) || 100);
    return c.json({
      data: entries.map((entry) => ({ ...entry, at: entry.at.toISOString() })),
    });
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

  // ---- Agent settings (Admin → Agents) -----------------------------------------

  const agentSettings = async (): Promise<AgentSettings> => ({
    ...defaultAgentSettings(),
    ...((await store.setting('agents')) as Partial<AgentSettings> | null),
  });
  const providedAgents = async (): Promise<ProvidedAgent[]> => {
    const saved = (await store.setting('provided')) as { agents?: ProvidedAgent[] } | null;
    return saved?.agents?.length ? saved.agents : defaultProvided(config.agentName);
  };
  /** What the platform offers this app: its team's published models and the templates it may use. */
  const offered = async () => {
    const [models, templates] = await Promise.all([platform.teamModels(), platform.templates()]);
    return {
      models: models.filter((model) => model.enabled),
      templates,
      modelIds: new Set(models.filter((model) => model.enabled).map((model) => model.id)),
      templateIds: new Set(templates.map((template) => template.id)),
    };
  };
  /** The default model, resolved: the admin's choice, else AGENT_MODEL. Null: the platform decides. */
  const defaultModelId = async (settings: AgentSettings) =>
    (await platform.resolveModelId(settings.defaultModelId)) ??
    (await platform.configuredModelId());
  const allowedTemplates = async (settings: AgentSettings) => {
    const templates = await platform.templates();
    return settings.allowedTemplateIds === null
      ? templates
      : templates.filter((template) => settings.allowedTemplateIds!.includes(template.id));
  };

  /** What the app shows for an agent: the platform's record with the app's own name and kind. */
  const agentView = (
    agent: PlatformAgent,
    extra: { name: string; description: string; kind: 'provided' | 'personal' },
  ) => ({ ...agent, ...extra });

  /**
   * The person's agents: every provided agent (made the first time it is
   * listed, and kept on the model it should be on) and the agents they made.
   */
  app.get('/api/agents', async (c) => {
    const person = c.get('person');
    const who = person.name || person.email;
    try {
      const [settings, provided, mine, managed] = await Promise.all([
        agentSettings(),
        providedAgents(),
        store.personalAgents(person.id),
        platform.managedAgents(),
      ]);
      const fallbackModel = await defaultModelId(settings);
      const out = [];
      for (const spec of provided) {
        const key = keys.provided(person.id, spec.id);
        const modelId = (await platform.resolveModelId(spec.modelId)) ?? fallbackModel;
        let agent = managed.get(key);
        if (!agent || (modelId && agent.model?.id !== modelId))
          agent = await platform.ensureAgent(key, {
            // Named for the team's owners, who see every person's agent in the console.
            name: `${spec.name} · ${who}`,
            description: `${spec.name} for ${person.email || who}`,
            ...(spec.templateId
              ? { templateId: spec.templateId }
              : config.agentTemplate
                ? { template: config.agentTemplate }
                : {}),
            modelId,
          });
        out.push(
          agentView(agent, { name: spec.name, description: spec.description, kind: 'provided' }),
        );
      }
      for (const row of mine) {
        const agent = managed.get(keys.personal(person.id, row.slot));
        if (!agent) {
          // Deleted on the platform (by a team owner): forget it here too.
          await store.removePersonalAgent(person.id, row.slot);
          continue;
        }
        out.push(agentView(agent, { name: row.name, description: '', kind: 'personal' }));
      }
      return c.json({ data: out });
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  /** What a person may make agents from: the allowed templates, the models, and their limit. */
  app.get('/api/agents/catalog', async (c) => {
    try {
      const settings = await agentSettings();
      const [templates, models, mine] = await Promise.all([
        allowedTemplates(settings),
        settings.allowModelChoice ? platform.teamModels() : Promise.resolve([]),
        store.personalAgents(c.get('person').id),
      ]);
      return c.json({
        data: {
          templates: templates.map(({ id, name, description }) => ({
            id,
            name,
            description: description ?? '',
          })),
          models: models.filter((model) => model.enabled).map(({ id, name }) => ({ id, name })),
          defaultModelId: await defaultModelId(settings),
          allowModelChoice: settings.allowModelChoice,
          limit: settings.personalLimit,
          used: mine.length,
        },
      });
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  /** Makes one of the person's own agents. */
  app.post('/api/agents', async (c) => {
    const person = c.get('person');
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      templateId?: unknown;
      modelId?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60)
      return fail(c, 400, 'invalid_name', 'Give the agent a name of 1 to 60 characters.');
    try {
      const settings = await agentSettings();
      const mine = await store.personalAgents(person.id);
      if (mine.length >= settings.personalLimit)
        return fail(
          c,
          409,
          'limit',
          settings.personalLimit === 0
            ? 'Making agents is turned off. Ask an administrator.'
            : `You can have up to ${settings.personalLimit} agents of your own. Delete one to make another.`,
        );
      const templates = await allowedTemplates(settings);
      const template = templates.find((candidate) => candidate.id === body.templateId);
      if (!template)
        return fail(c, 400, 'invalid_template', 'Choose one of the templates offered.');
      let modelId = await defaultModelId(settings);
      if (settings.allowModelChoice && typeof body.modelId === 'string' && body.modelId) {
        modelId = await platform.resolveModelId(body.modelId);
        if (!modelId) return fail(c, 400, 'invalid_model', 'Choose one of the models offered.');
      }
      const slot = token(6).replace(/[^A-Za-z0-9]/g, 'x');
      const who = person.name || person.email;
      const agent = await platform.ensureAgent(keys.personal(person.id, slot), {
        name: `${name} · ${who}`,
        description: `${name}, made by ${person.email || who}`,
        templateId: template.id,
        modelId,
      });
      await store.addPersonalAgent(person.id, slot, name);
      return c.json({ data: agentView(agent, { name, description: '', kind: 'personal' }) }, 201);
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  /** One of the person's own agents (renamed, moved to another model, deleted), or a 404. */
  const ownPersonalAgent = async (c: Context<Env>) => {
    const agentId = c.req.param('agentId') ?? '';
    if (!UUID.test(agentId)) return null;
    const person = c.get('person');
    const agent = [...(await platform.managedAgents()).values()].find(
      (candidate) => candidate.id === agentId,
    );
    const kind = kindOfKey(person.id, agent?.externalKey);
    return agent && kind?.kind === 'personal' ? { agent, slot: kind.slot } : null;
  };

  app.patch('/api/agents/:agentId', async (c) => {
    const person = c.get('person');
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; modelId?: unknown };
    try {
      const own = await ownPersonalAgent(c);
      if (!own) return fail(c, 404, 'not_found', 'Agent not found');
      const settings = await agentSettings();
      const change: { name?: string; modelId?: string } = {};
      let name: string | undefined;
      if (body.name !== undefined) {
        name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 60)
          return fail(c, 400, 'invalid_name', 'A name of 1 to 60 characters.');
        change.name = `${name} · ${person.name || person.email}`.slice(0, 100);
      }
      if (body.modelId !== undefined) {
        if (!settings.allowModelChoice)
          return fail(c, 403, 'model_fixed', 'Your administrator chooses the model.');
        const modelId = await platform.resolveModelId(
          typeof body.modelId === 'string' ? body.modelId : null,
        );
        if (!modelId) return fail(c, 400, 'invalid_model', 'Choose one of the models offered.');
        change.modelId = modelId;
      }
      const agent = Object.keys(change).length
        ? await platform.patchAgent(own.agent, change)
        : own.agent;
      if (name) await store.renamePersonalAgent(person.id, own.slot, name);
      const rows = await store.personalAgents(person.id);
      const row = rows.find((candidate) => candidate.slot === own.slot);
      return c.json({
        data: agentView(agent, {
          name: row?.name ?? agent.name,
          description: '',
          kind: 'personal',
        }),
      });
    } catch (error) {
      return platformFailure(c, error);
    }
  });

  /** Deletes one of the person's own agents and all its conversations. Provided agents cannot be deleted. */
  app.delete('/api/agents/:agentId', async (c) => {
    try {
      const own = await ownPersonalAgent(c);
      if (!own) return fail(c, 404, 'not_found', 'Agent not found');
      await platform.deleteAgent(own.agent.id);
      await store.removePersonalAgent(c.get('person').id, own.slot);
      return c.json({ data: { ok: true } });
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

  /**
   * The person's own conversations as they change: created, renamed, started,
   * finished, deleted (see events-hub.ts). `ready` when connected; `resync`
   * when events may have been missed and the lists should be read again.
   */
  const eventStreams = new Map<string, number>();
  app.get('/api/events', requireSession, (c) => {
    const user = c.get('session').user;
    const open = eventStreams.get(user.id) ?? 0;
    if (open >= MAX_EVENT_STREAMS_PER_USER)
      return fail(c, 429, 'too_many_streams', 'Too many tabs are open at once.');
    eventStreams.set(user.id, open + 1);
    const encoder = new TextEncoder();
    let cleanup: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const write = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        const unsubscribe = events.subscribe({
          user,
          send: (event, data) => write(`event: ${event}\ndata: ${data}\n\n`),
        });
        const keepAlive = setInterval(() => write(': keep-alive\n\n'), KEEP_ALIVE_MS);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          unsubscribe();
          const left = (eventStreams.get(user.id) ?? 1) - 1;
          if (left <= 0) eventStreams.delete(user.id);
          else eventStreams.set(user.id, left);
          try {
            controller.close();
          } catch {
            // Already closed by the reader going away.
          }
        };
        c.req.raw.signal.addEventListener('abort', () => cleanup(), { once: true });
        write('event: ready\ndata: {}\n\n');
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  app.all('/api/*', (c) => fail(c, 404, 'not_found', 'Not found'));

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error('[server] unhandled', error);
    return fail(c, 500, 'internal', 'Internal error');
  });

  return app;
}
