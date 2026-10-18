// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import type { Config } from '../../server/config.ts';
import { Connect } from '../../server/connect.ts';
import type { Platform } from '../../server/platform.ts';
import { MemoryStore } from '../../server/store.ts';

const PLATFORM = 'https://agents.example.com';
const APP = 'http://localhost:5177';

const config: Config = {
  appUrl: new URL(APP),
  host: '127.0.0.1',
  port: 0,
  platformUrl: new URL(PLATFORM),
  platformAuth: 'connect',
  platformTeam: '',
  platformServiceKey: '',
  agentTemplate: 'assistant',
  agentName: 'Assistant',
  agentModel: '',
  sessionSecret: 'x'.repeat(40),
  sessionTtlSeconds: 3600,
  oidc: null,
  devAuth: true,
  staticDir: null,
  databaseUrl: '',
  initialAdminEmail: 'tim@example.test',
};

const PERSONAL = { id: 'team-personal', slug: 'tim-personal', name: 'Tim', kind: 'personal' };
const TEAM = { id: 'team-research', slug: 'research', name: 'Research', kind: 'team' };

/** The platform as one person (Tim) sees it: OAuth, his teams, agents in each, templates and models. */
function fakePlatform() {
  const calls: string[] = [];
  const codes = new Set<string>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  let n = 0;
  let nextAgent = 0;
  let email = 'tim@example.test';
  const agents = new Map<string, Record<string, unknown>>();
  const add = (team: typeof PERSONAL, name: string, extra: Record<string, unknown> = {}) => {
    const id = `00000000-0000-4000-8000-${String(++nextAgent).padStart(12, '0')}`;
    agents.set(id, {
      id,
      name,
      description: '',
      teamId: team.id,
      teamSlug: team.slug,
      teamName: team.name,
      enabled: true,
      running: false,
      revision: 1,
      ...extra,
    });
    return id;
  };
  const teamAgent = add(TEAM, 'Research bot');
  const json = (data: unknown, status = 200) => Response.json({ data }, { status });
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname;
    if (path === '/v1/auth/config')
      return json({
        connect: {
          issuer: PLATFORM,
          authorizationEndpoint: `${PLATFORM}/oauth/authorize`,
          tokenEndpoint: `${PLATFORM}/oauth/token`,
          revocationEndpoint: `${PLATFORM}/oauth/revoke`,
          registrationEndpoint: `${PLATFORM}/oauth/register`,
        },
      });
    if (path === '/oauth/register')
      return Response.json({ client_id: 'pdpc_app' }, { status: 201 });
    if (path === '/oauth/token') {
      const form = new URLSearchParams(String(init.body));
      const ok =
        form.get('grant_type') === 'authorization_code'
          ? codes.delete(form.get('code')!)
          : refresh.delete(form.get('refresh_token')!);
      if (!ok) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      n++;
      access.add(`pdpat_${n}`);
      refresh.add(`pdprt_${n}`);
      return Response.json({
        access_token: `pdpat_${n}`,
        refresh_token: `pdprt_${n}`,
        expires_in: 3600,
      });
    }
    if (path === '/oauth/revoke') {
      refresh.delete(new URLSearchParams(String(init.body)).get('token')!);
      return new Response(null);
    }
    const bearer = new Headers(init.headers).get('Authorization')?.replace('Bearer ', '') ?? '';
    if (!access.has(bearer)) return new Response('{}', { status: 401 });
    calls.push(`${method} ${path}`);
    if (path === '/v1/me') return json({ user: { id: 'u-tim', email, displayName: 'Tim' } });
    if (path === '/v1/teams') return json([PERSONAL, TEAM]);
    if (path === '/v1/agent-templates')
      // The catalog: platform templates and published team templates. A team's own unpublished
      // template (t-team) isn't in it.
      return json([
        { id: 't-assistant', slug: 'assistant', name: 'Assistant', teamId: null },
        { id: 't-published', slug: 'published', name: 'Published', teamId: TEAM.id },
      ]);
    if (path === `/v1/teams/${PERSONAL.slug}/models`)
      return json([{ id: 'm-oss', name: 'gpt-oss-120b', enabled: true }]);
    if (path === `/v1/teams/${PERSONAL.slug}/limits`)
      return json({ kind: 'personal', maxAgents: 10, agentCount: [...agents.values()].length });
    if (path === '/v1/agents') return json([...agents.values()]);
    if (path === `/v1/teams/${PERSONAL.slug}/agents` && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const taken = [...agents.values()].some(
        (a) => a.teamId === PERSONAL.id && String(a.name).toLowerCase() === body.name.toLowerCase(),
      );
      if (taken)
        return Response.json(
          { error: { code: 'name_taken', message: 'Names are unique.' } },
          { status: 409 },
        );
      const id = add(PERSONAL, body.name, {
        templateId: body.templateId,
        model: body.modelId ? { id: body.modelId } : null,
      });
      return json(agents.get(id), 201);
    }
    const one = /^\/v1\/agents\/([^/]+)$/.exec(path);
    if (one) {
      const agent = agents.get(one[1]!);
      if (!agent) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      if (method === 'GET') return json(agent);
      if (method === 'DELETE') {
        agents.delete(one[1]!);
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        if (new Headers(init.headers).get('If-Match') !== `"${agent.revision}"`)
          return Response.json({ error: { code: 'precondition' } }, { status: 412 });
        Object.assign(agent, JSON.parse(String(init.body)), {
          revision: Number(agent.revision) + 1,
        });
        return json(agent);
      }
    }
    if (/^\/v1\/agents\/[^/]+\/threads$/.test(path)) return json([]);
    return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    agents,
    teamAgent,
    fetch: fetchImpl,
    /** The person approves the app: the code they'd come back with. */
    approve(url: string) {
      const code = `code_${codes.size + 1}`;
      codes.add(code);
      const u = new URL(url);
      return { code, state: u.searchParams.get('state')!, iss: PLATFORM };
    },
    setEmail(value: string) {
      email = value;
    },
    refreshTokens: refresh,
    revokeAll() {
      access.clear();
      refresh.clear();
    },
  };
}

let platform: ReturnType<typeof fakePlatform>;
let app: ReturnType<typeof createApp>;
let store: MemoryStore;

beforeEach(() => {
  platform = fakePlatform();
  store = new MemoryStore();
  const connect = new Connect(config, store, async () => 'Pi Agent Interface', platform.fetch);
  app = createApp(config, { store, platform: {} as Platform, connect });
});

async function signIn() {
  const response = await app.request('/auth/dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP },
    body: JSON.stringify({ account: 'tim' }),
  });
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const me = await (await app.request('/api/me', { headers: { Cookie: cookie } })).json();
  return { cookie, csrf: me.data.csrfToken as string, me: me.data };
}

async function connectTim(expectOk = true) {
  const tim = await signIn();
  const start = await app.request('/connect/start?next=/after', {
    headers: { Cookie: tim.cookie },
  });
  expect(start.status).toBe(302);
  const pending = start.headers.get('set-cookie')!.split(';')[0]!;
  const back = platform.approve(start.headers.get('location')!);
  const query = new URLSearchParams(back).toString();
  const done = await app.request(`/connect/callback?${query}`, {
    headers: { Cookie: `${tim.cookie}; ${pending}` },
  });
  expect(done.status).toBe(302);
  if (expectOk) expect(done.headers.get('location')).toBe('/after');
  return { ...tim, done };
}

const get = (path: string, cookie: string) => app.request(path, { headers: { Cookie: cookie } });
const write = (
  method: string,
  path: string,
  who: { cookie: string; csrf: string },
  body?: unknown,
) =>
  app.request(path, {
    method,
    headers: {
      Cookie: who.cookie,
      'X-CSRF-Token': who.csrf,
      Origin: APP,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('Connect mode', () => {
  it('says it uses Connect, and asks the person to connect before anything else', async () => {
    const tim = await signIn();
    expect(tim.me.platform).toEqual({ mode: 'connect', account: null });
    const agents = await get('/api/agents', tim.cookie);
    expect(agents.status).toBe(409);
    expect((await agents.json()).error.code).toBe('not_connected');
    expect((await get('/api/events', tim.cookie)).status).toBe(409);
  });

  it('publishes the client metadata document', async () => {
    const response = await app.request('/oauth/client-metadata.json');
    expect(response.status).toBe(200);
    expect((await response.json()).redirect_uris).toEqual([`${APP}/connect/callback`]);
  });

  it('connects, then lists the provided assistant (made once, in the personal workspace), their own and team agents', async () => {
    const tim = await connectTim();
    const me = await (await get('/api/me', tim.cookie)).json();
    expect(me.data.platform.account.email).toBe('tim@example.test');

    const [first, second] = await Promise.all([
      get('/api/agents', tim.cookie),
      get('/api/agents', tim.cookie),
    ]);
    const list = (await first.json()).data as Array<{
      name: string;
      kind: string;
      teamId: string;
      teamName?: string;
    }>;
    await second.json();
    expect(list.map((agent) => [agent.name, agent.kind])).toEqual([
      ['Assistant', 'provided'],
      ['Research bot', 'team'],
    ]);
    expect(list[0]!.teamId).toBe(PERSONAL.id);
    expect(list[1]!.teamName).toBe('Research');
    expect(
      platform.calls.filter((call) => call === `POST /v1/teams/${PERSONAL.slug}/agents`),
    ).toHaveLength(1);
    // Listed again: the copy is remembered, not made again.
    await get('/api/agents', tim.cookie);
    expect(
      platform.calls.filter((call) => call === `POST /v1/teams/${PERSONAL.slug}/agents`),
    ).toHaveLength(1);
  });

  it('makes, renames and deletes the person’s own agents, and nothing else', async () => {
    const tim = await connectTim();
    await get('/api/agents', tim.cookie);
    const made = await write('POST', '/api/agents', tim, {
      name: 'Researcher',
      templateId: 't-assistant',
    });
    expect(made.status).toBe(201);
    const agent = (await made.json()).data;
    expect(agent).toMatchObject({ name: 'Researcher', kind: 'personal', teamId: PERSONAL.id });
    // Team templates can't go in a personal workspace.
    expect(
      (await write('POST', '/api/agents', tim, { name: 'X', templateId: 't-team' })).status,
    ).toBe(400);

    const renamed = await write('PATCH', `/api/agents/${agent.id}`, tim, {
      name: 'Research helper',
    });
    expect((await renamed.json()).data.name).toBe('Research helper');

    const list = (await (await get('/api/agents', tim.cookie)).json()).data as Array<{
      id: string;
      kind: string;
    }>;
    const provided = list.find((candidate) => candidate.kind === 'provided')!;
    expect((await write('DELETE', `/api/agents/${provided.id}`, tim)).status).toBe(404);
    expect((await write('DELETE', `/api/agents/${platform.teamAgent}`, tim)).status).toBe(404);
    expect((await write('DELETE', `/api/agents/${agent.id}`, tim)).status).toBe(200);
    expect(platform.agents.has(agent.id)).toBe(false);
  });

  it('relays conversations with the person’s own token', async () => {
    const tim = await connectTim();
    const response = await get(`/api/agents/${platform.teamAgent}/threads`, tim.cookie);
    expect(response.status).toBe(200);
    expect(platform.calls).toContain(`GET /v1/agents/${platform.teamAgent}/threads`);
  });

  it('asks to connect again when the platform revokes the connection, and disconnects on request', async () => {
    const tim = await connectTim();
    platform.revokeAll();
    const response = await get('/api/agents', tim.cookie);
    expect(response.status).toBe(409);
    expect((await (await get('/api/me', tim.cookie)).json()).data.platform.account).toBeNull();

    const again = await connectTim();
    expect((await write('POST', '/api/me/platform/disconnect', again)).status).toBe(200);
    expect((await get('/api/agents', again.cookie)).status).toBe(409);
  });

  it('refuses a platform account that is not the person’s own, and revokes what it got', async () => {
    platform.setEmail('someone.else@example.test');
    const { done } = await connectTim(false);
    expect(decodeURIComponent(done.headers.get('location')!)).toContain(
      "You connected someone.else@example.test on the agent platform, but you're signed in here as tim@example.test",
    );
    expect(platform.refreshTokens.size).toBe(0); // revoked
    const tim = await signIn();
    expect((await get('/api/agents', tim.cookie)).status).toBe(409); // not connected
  });

  it('adopts the agent that is already there when its name is taken, instead of failing or duplicating', async () => {
    const tim = await connectTim();
    await get('/api/agents', tim.cookie);
    const [person] = await store.people();
    await store.removeProvidedCopy(person!.id, 'assistant'); // the app's record is lost; the agent is not
    const list = (await (await get('/api/agents', tim.cookie)).json()).data as Array<{
      name: string;
      kind: string;
    }>;
    expect(list.filter((agent) => agent.kind === 'provided')).toHaveLength(1);
    expect(
      [...platform.agents.values()].filter((agent) => agent.name === 'Assistant'),
    ).toHaveLength(1);
  });

  it('locks Admin → Usage off, with the reason', async () => {
    const tim = await connectTim();
    const features = (await (await get('/api/admin/features', tim.cookie)).json()).data;
    expect(features.find((feature: { id: string }) => feature.id === 'usage')).toMatchObject({
      enabled: false,
      locked: true,
    });
  });
});
