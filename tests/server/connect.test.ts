// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Connect, ConnectError, NotConnected } from '../../server/connect.ts';
import { MemoryStore } from '../../server/store.ts';

const PLATFORM = 'https://agents.example.com';

/** A platform authorization server: issues, rotates and revokes tokens, and records what it was asked. */
function fakePlatform() {
  const calls: string[] = [];
  let issued = 0;
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  let registered = 0;
  const pair = () => {
    issued++;
    const access = `pdpat_${issued}`;
    const refresh = `pdprt_${issued}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer' };
  };
  const server = {
    calls,
    codes,
    accessTokens,
    refreshTokens,
    get issued() {
      return issued;
    },
    get registered() {
      return registered;
    },
    /** Lets the next authorize "happen": the code the person would come back with. */
    approve(url: string) {
      const u = new URL(url);
      const code = `code_${codes.size + 1}`;
      codes.set(code, {
        challenge: u.searchParams.get('code_challenge')!,
        clientId: u.searchParams.get('client_id')!,
      });
      return { code, state: u.searchParams.get('state')!, iss: PLATFORM };
    },
    fetch: (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/v1/auth/config')
        return Response.json({
          data: {
            connect: {
              issuer: PLATFORM,
              authorizationEndpoint: `${PLATFORM}/oauth/authorize`,
              tokenEndpoint: `${PLATFORM}/oauth/token`,
              revocationEndpoint: `${PLATFORM}/oauth/revoke`,
              registrationEndpoint: `${PLATFORM}/oauth/register`,
            },
          },
        });
      if (url.pathname === '/oauth/register') {
        registered++;
        return Response.json({ client_id: `pdpc_${registered}` }, { status: 201 });
      }
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(String(init.body));
        if (form.get('grant_type') === 'authorization_code') {
          const code = codes.get(form.get('code')!);
          const verifier = form.get('code_verifier')!;
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!code || code.challenge !== challenge || code.clientId !== form.get('client_id'))
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          codes.delete(form.get('code')!);
          return Response.json(pair());
        }
        const refresh = form.get('refresh_token')!;
        if (!refreshTokens.delete(refresh))
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json(pair());
      }
      if (url.pathname === '/oauth/revoke') {
        refreshTokens.delete(new URLSearchParams(String(init.body)).get('token')!);
        return new Response(null, { status: 200 });
      }
      const auth = new Headers(init.headers).get('Authorization')?.replace('Bearer ', '');
      if (!auth || !accessTokens.has(auth)) return new Response('{}', { status: 401 });
      if (url.pathname === '/v1/me')
        return Response.json({
          data: { user: { id: 'u1', email: 'tim@example.test', name: 'Tim' } },
        });
      return Response.json({ data: [], token: auth });
    }) as typeof fetch,
  };
  return server;
}

let store: MemoryStore;
let platform: ReturnType<typeof fakePlatform>;
const connectAt = (appUrl: string) =>
  new Connect(
    { appUrl: new URL(appUrl), platformUrl: new URL(PLATFORM), sessionSecret: 'x'.repeat(40) },
    store,
    async () => 'Pi Agent Interface',
    platform.fetch,
  );

beforeEach(async () => {
  store = new MemoryStore();
  platform = fakePlatform();
  await store.signIn({ id: 'tim', email: 'tim@example.test', name: 'Tim' }, null);
});

async function connected(connect: Connect, personId: string) {
  const { url, pending } = await connect.start(personId, '/after');
  const back = platform.approve(url);
  return connect.finish(personId, back, pending);
}

describe('Connect', () => {
  it('identifies an https app by its metadata document, and publishes it', async () => {
    const connect = connectAt('https://chat.example.com');
    expect(await connect.clientId()).toBe('https://chat.example.com/oauth/client-metadata.json');
    expect(await connect.metadata()).toMatchObject({
      client_id: 'https://chat.example.com/oauth/client-metadata.json',
      client_name: 'Pi Agent Interface',
      redirect_uris: ['https://chat.example.com/connect/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(platform.registered).toBe(0);
  });

  it('registers a loopback app once, and keeps the client', async () => {
    const connect = connectAt('http://localhost:5177');
    expect(await connect.clientId()).toBe('pdpc_1');
    expect(await connect.clientId()).toBe('pdpc_1');
    expect(platform.registered).toBe(1);
  });

  it('sends the person to authorize with PKCE, and keeps their tokens encrypted', async () => {
    const connect = connectAt('https://chat.example.com');
    const { url } = await connect.start('tim', '/after');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${PLATFORM}/oauth/authorize`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('agents');
    expect(u.searchParams.get('redirect_uri')).toBe('https://chat.example.com/connect/callback');

    expect(await connected(connect, 'tim')).toBe('/after');
    const row = await store.connection('tim');
    expect(row?.platformEmail).toBe('tim@example.test');
    expect(row?.accessToken).not.toContain('pdpat_');
    expect(row?.refreshToken).not.toContain('pdprt_');
    expect(await connect.accessToken('tim')).toBe('pdpat_1');
  });

  it('refuses a callback with the wrong state, another person’s attempt, or a refusal', async () => {
    const connect = connectAt('https://chat.example.com');
    const { url, pending } = await connect.start('tim', '/');
    const back = platform.approve(url);
    await expect(connect.finish('tim', { ...back, state: 'nope' }, pending)).rejects.toBeInstanceOf(
      ConnectError,
    );
    await expect(connect.finish('bob', back, pending)).rejects.toBeInstanceOf(ConnectError);
    await expect(
      connect.finish('tim', { state: back.state, error: 'access_denied' }, pending),
    ).rejects.toMatchObject({
      message: 'You chose not to connect.',
    });
    await expect(
      connect.finish('tim', { ...back, iss: 'https://evil.example' }, pending),
    ).rejects.toMatchObject({
      code: 'invalid_issuer',
    });
  });

  it('refreshes an expired token once, however many requests want it', async () => {
    const connect = connectAt('https://chat.example.com');
    await connected(connect, 'tim');
    const row = (await store.connection('tim'))!;
    await store.saveConnection('tim', { ...row, accessExpiresAt: new Date(Date.now() - 1000) });
    const tokens = await Promise.all([1, 2, 3, 4].map(() => connect.accessToken('tim')));
    expect(new Set(tokens)).toEqual(new Set(['pdpat_2']));
    expect(platform.issued).toBe(2);
  });

  it('retries a refused request once with a fresh token', async () => {
    const connect = connectAt('https://chat.example.com');
    await connected(connect, 'tim');
    platform.accessTokens.delete('pdpat_1'); // the platform stops honouring it
    const response = await connect.fetchAs('tim', '/v1/agents');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { token: string }).token).toBe('pdpat_2');
  });

  it('forgets the connection when the platform revokes it', async () => {
    const connect = connectAt('https://chat.example.com');
    await connected(connect, 'tim');
    platform.accessTokens.clear();
    platform.refreshTokens.clear(); // disconnected in the platform's Connected apps
    await expect(connect.fetchAs('tim', '/v1/agents')).rejects.toBeInstanceOf(NotConnected);
    expect(await store.connection('tim')).toBeNull();
    await expect(connect.accessToken('tim')).rejects.toBeInstanceOf(NotConnected);
  });

  it('revokes the refresh token on disconnect', async () => {
    const connect = connectAt('https://chat.example.com');
    await connected(connect, 'tim');
    await connect.disconnect('tim');
    expect(platform.refreshTokens.has('pdprt_1')).toBe(false);
    expect(await store.connection('tim')).toBeNull();
  });
});
