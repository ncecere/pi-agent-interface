// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import { type Config, loadConfig } from '../../server/config.ts';
import type { Platform } from '../../server/platform.ts';
import { userIdFor } from '../../server/session.ts';

/**
 * A real OpenID Connect round trip against a small in-process identity
 * provider: discovery, the authorization redirect, PKCE, the code exchange,
 * and ID token verification (signature, issuer, audience, nonce).
 */

const CLIENT_ID = 'pai';
const CLIENT_SECRET = 'secret';
const APP = 'http://localhost:5177';

let server: Server;
let issuer: string;
let jwk: JWK;
let signingKey: CryptoKey;
/** What the provider remembers about each authorization it granted. */
const grants = new Map<string, { challenge: string; nonce: string; redirect: string }>();
/** Lets a test make the provider misbehave. */
const mischief = { nonce: null as string | null, audience: null as string | null };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    const json = (body: unknown, status = 200) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/token' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', async () => {
        const form = new URLSearchParams(body);
        const grant = grants.get(form.get('code') ?? '');
        // The client authenticates with HTTP Basic or in the body; providers accept both.
        const basic = Buffer.from(
          request.headers.authorization?.replace('Basic ', '') ?? '',
          'base64',
        ).toString();
        const authenticated =
          basic === `${CLIENT_ID}:${CLIENT_SECRET}` ||
          (form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET);
        if (!grant || !authenticated) return json({ error: 'invalid_grant' }, 400);
        // PKCE: the verifier must hash to the challenge sent at authorize.
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (challenge !== grant.challenge || form.get('redirect_uri') !== grant.redirect)
          return json({ error: 'invalid_grant' }, 400);
        const idToken = await new SignJWT({
          nonce: mischief.nonce ?? grant.nonce,
          email: 'sally@example.com',
          name: 'Sally Smith',
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setSubject('sub-123')
          .setAudience(mischief.audience ?? CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(signingKey);
        json({ access_token: 'at', token_type: 'Bearer', id_token: idToken });
      });
      return;
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const platform = {
  async fetch() {
    return Response.json({ data: [] });
  },
} as unknown as Platform;

function appFor(overrides: Partial<Config> = {}) {
  const config: Config = {
    appUrl: new URL(APP),
    host: '127.0.0.1',
    port: 0,
    platformUrl: new URL('http://localhost:8098'),
    platformTeam: 'pai',
    platformServiceKey: 'pdp_sa_test',
    agentTemplate: '',
    agentName: 'Assistant',
    agentModel: '',
    sessionSecret: 'x'.repeat(40),
    sessionTtlSeconds: 3600,
    oidc: {
      issuer: new URL(issuer),
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: 'openid profile email',
    },
    devAuth: false,
    staticDir: null,
    ...overrides,
  };
  return createApp(config, platform);
}

const cookieOf = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0];

/** Starts sign-in; plays the browser through the provider; returns the callback URL and the login cookie. */
async function signInStart(app: ReturnType<typeof appFor>, next?: string) {
  const start = await app.request(`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.origin).toBe(issuer);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  grants.set(code, {
    challenge: authorize.searchParams.get('code_challenge')!,
    nonce: authorize.searchParams.get('nonce')!,
    redirect: authorize.searchParams.get('redirect_uri')!,
  });
  return {
    authorize,
    cookie: cookieOf(start, 'pai_login')!,
    callback: (params: Record<string, string>) =>
      `/auth/callback?${new URLSearchParams({ code, state: authorize.searchParams.get('state')!, ...params })}`,
  };
}

const FAILED = { location: '/sign-in?error=failed', session: undefined };

/** Signs in from start to finish, with the callback changed as asked. What came back. */
async function complete(
  app: ReturnType<typeof appFor>,
  options: {
    next?: string;
    params?: (state: Record<string, string>) => Record<string, string>;
    cookie?: boolean;
  } = {},
) {
  const { cookie, callback, authorize } = await signInStart(app, options.next);
  const params = options.params?.({ state: authorize.searchParams.get('state')! }) ?? {};
  const done = await app.request(callback(params), {
    headers: options.cookie === false ? {} : { Cookie: cookie },
  });
  return { location: done.headers.get('location'), session: cookieOf(done, 'pai_session'), done };
}

describe('single sign-on', () => {
  it('sends the person to the provider with PKCE, state and nonce', async () => {
    const { authorize } = await signInStart(appFor());
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${APP}/auth/callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toBe('openid profile email');
    for (const name of ['state', 'nonce', 'code_challenge'])
      expect(authorize.searchParams.get(name)).toBeTruthy();
  });

  it('signs the person in and returns them to where they were going', async () => {
    const app = appFor();
    const { cookie, callback } = await signInStart(app, '/agents/a/threads/t');
    const done = await app.request(callback({}), { headers: { Cookie: cookie } });
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/agents/a/threads/t');

    const session = cookieOf(done, 'pai_session')!;
    expect(session).toBeTruthy();
    const me = await (await app.request('/api/me', { headers: { Cookie: session } })).json();
    expect(me.data.user).toEqual({
      id: userIdFor(issuer, 'sub-123'),
      name: 'Sally Smith',
      email: 'sally@example.com',
    });
  });

  it('never redirects off-site, whatever "next" says', async () => {
    const app = appFor();
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const { cookie, callback } = await signInStart(app, next);
      const done = await app.request(callback({}), { headers: { Cookie: cookie } });
      expect(done.headers.get('location'), next).toBe('/');
    }
  });

  // Each refusal first shows the same sign-in succeeding, so it is refused for the reason named.
  it('refuses a callback with the wrong state', async () => {
    const app = appFor();
    expect((await complete(app)).session).toBeTruthy();
    const { location, session } = await complete(app, { params: () => ({ state: 'forged' }) });
    expect({ location, session }).toEqual(FAILED);
  });

  it('refuses a callback with no sign-in in progress, or one that has expired', async () => {
    const app = appFor();
    expect((await complete(app)).session).toBeTruthy();
    const { location, session } = await complete(app, { cookie: false });
    expect({ location, session }).toEqual({
      location: '/sign-in?error=expired',
      session: undefined,
    });
  });

  it('refuses a callback the provider did not issue a code for', async () => {
    const app = appFor();
    expect((await complete(app)).session).toBeTruthy();
    const { location, session } = await complete(app, { params: () => ({ code: 'made-up' }) });
    expect({ location, session }).toEqual(FAILED);
  });

  describe('a provider that misbehaves', () => {
    const reset = () => Object.assign(mischief, { nonce: null, audience: null });
    afterEach(reset);

    const refused = async (misbehave: () => void) => {
      const app = appFor();
      expect(
        (await complete(app)).session,
        'the same sign-in works without the tampering',
      ).toBeTruthy();
      misbehave();
      const { location, session } = await complete(app);
      expect({ location, session }).toEqual(FAILED);
    };

    it('is refused for a replayed (wrong) nonce', () =>
      refused(() => {
        mischief.nonce = 'someone-elses';
      }));
    it('is refused for a token meant for another client', () =>
      refused(() => {
        mischief.audience = 'another-app';
      }));
  });

  it('is not offered when it is not configured', async () => {
    const app = appFor({ oidc: null, devAuth: true });
    expect((await app.request('/auth/login')).status).toBe(404);
    expect((await app.request('/auth/callback')).status).toBe(404);
  });
});

describe('configuration', () => {
  it('serves its own health check without calling the platform', async () => {
    const response = await appFor().request('/healthz');
    expect(await response.json()).toEqual({ ok: true });
  });
});

/**
 * An ID token that comes straight from the provider's token endpoint is not
 * signature-checked: OIDC Core 3.1.3.7 lets the client rely on the TLS
 * connection to the provider instead. So the connection must be https, and the
 * server refuses to start with anything else (loopback excepted, for tests and
 * local development).
 */
describe('loadConfig', () => {
  const good = {
    APP_URL: 'https://chat.example.com',
    PLATFORM_URL: 'https://agents.example.com',
    PLATFORM_TEAM: 'pai',
    PLATFORM_SERVICE_KEY: 'pdp_sa_x',
    SESSION_SECRET: 'x'.repeat(40),
    OIDC_ISSUER: 'https://auth.example.com/application/o/pai/',
    OIDC_CLIENT_ID: 'pai',
    OIDC_CLIENT_SECRET: 'secret',
  };
  const problems = (env: Record<string, string | undefined>) => {
    try {
      loadConfig({ ...good, ...env } as NodeJS.ProcessEnv);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };

  it('accepts a complete production configuration', () => {
    expect(problems({})).toBe('');
  });

  it('refuses a provider that is not https, except on loopback', () => {
    expect(problems({ OIDC_ISSUER: 'http://auth.example.com/' })).toContain(
      'OIDC_ISSUER must use https',
    );
    expect(
      problems({ OIDC_ISSUER: 'http://127.0.0.1:9000/', APP_URL: 'http://localhost:5177' }),
    ).toBe('');
  });

  it('refuses a platform that is not https (the service key travels with every request)', () => {
    expect(problems({ PLATFORM_URL: 'http://agents.example.com' })).toContain(
      'PLATFORM_URL must use https',
    );
  });

  it('refuses development accounts anywhere but loopback', () => {
    expect(problems({ DEV_AUTH: 'true' })).toContain('DEV_AUTH requires a loopback APP_URL');
  });

  it('refuses a weak session secret and missing settings, naming each', () => {
    const message = problems({
      SESSION_SECRET: 'short',
      PLATFORM_SERVICE_KEY: '',
      PLATFORM_TEAM: '',
    });
    expect(message).toContain('SESSION_SECRET must be at least 32 characters');
    expect(message).toContain('PLATFORM_SERVICE_KEY is required');
    expect(message).toContain('PLATFORM_TEAM is required');
  });

  it('needs some way to sign in, and all three OIDC settings or none', () => {
    expect(
      problems({
        OIDC_ISSUER: undefined,
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: undefined,
      }),
    ).toContain('Configure OIDC_*');
    expect(problems({ OIDC_CLIENT_SECRET: undefined })).toContain('go together');
  });
});
