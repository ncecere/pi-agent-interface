// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createApp,
  MAX_EVENT_STREAMS_PER_USER,
  MAX_STREAMS_PER_USER,
  tolerant,
} from '../../server/app.ts';
import type { Config } from '../../server/config.ts';
import {
  agentKeyFor,
  ownsAgent,
  type Platform,
  type PlatformAgent,
} from '../../server/platform.ts';
import { userIdFor } from '../../server/session.ts';
import { MemoryStore } from '../../server/store.ts';

const config: Config = {
  appUrl: new URL('http://localhost:5177'),
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
  oidc: null,
  devAuth: true,
  staticDir: null,
  databaseUrl: '',
  initialAdminEmail: null,
};

const TIM_AGENT = '11111111-1111-4111-8111-111111111111';
const BOB_AGENT = '22222222-2222-4222-8222-222222222222';
const tim = { id: userIdFor('dev', 'tim'), name: 'Tim', email: 'tim@example.test' };
const bob = { id: userIdFor('dev', 'bob'), name: 'Bob', email: 'bob@example.test' };

/** A platform with Tim's and Bob's assistants; records what was relayed. */
function fakePlatform() {
  const agents: Record<string, PlatformAgent> = {
    [TIM_AGENT]: {
      id: TIM_AGENT,
      name: 'a',
      description: '',
      enabled: true,
      running: false,
      externalKey: agentKeyFor(tim),
    },
    [BOB_AGENT]: {
      id: BOB_AGENT,
      name: 'b',
      description: '',
      enabled: true,
      running: false,
      externalKey: agentKeyFor(bob),
    },
  };
  const relayed: string[] = [];
  const created: { key: string; templateId?: string; modelId?: string | null }[] = [];
  const deleted: string[] = [];
  let next = 0;
  const models = [
    { id: 'm-luna', name: 'gpt-6-luna', enabled: true },
    { id: 'm-oss', name: 'gpt-oss-120b', enabled: true },
  ];
  const templates = [
    { id: 't-assistant', slug: 'assistant', name: 'Assistant' },
    { id: 't-coder', slug: 'coder', name: 'Coder' },
  ];
  const byKey = () =>
    new Map(
      Object.values(agents)
        .filter((agent) => agent.externalKey)
        .map((agent) => [agent.externalKey!, agent]),
    );
  const platform = {
    relayed,
    created,
    deleted,
    async ensureAssistant(user: { id: string }) {
      return Object.values(agents).find((agent) => agent.externalKey === `u:${user.id}`)!;
    },
    async isOwnAgent(user: typeof tim, agentId: string) {
      const agent = agents[agentId];
      return agent ? ownsAgent(user, agent) : false;
    },
    async managedAgents() {
      return byKey();
    },
    async teamModels() {
      return models;
    },
    async templates() {
      return templates;
    },
    async resolveModelId(wanted: string | null | undefined) {
      return models.find((model) => model.id === wanted || model.name === wanted)?.id ?? null;
    },
    async configuredModelId() {
      return null;
    },
    async ensureAgent(
      key: string,
      spec: { name: string; templateId?: string; modelId?: string | null },
    ) {
      created.push({ key, templateId: spec.templateId, modelId: spec.modelId });
      const existing = byKey().get(key);
      if (existing) return existing;
      const id = `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
      agents[id] = {
        id,
        name: spec.name,
        description: '',
        enabled: true,
        running: false,
        externalKey: key,
      };
      return agents[id];
    },
    async patchAgent(agent: PlatformAgent, body: { name?: string; modelId?: string }) {
      agents[agent.id] = { ...agents[agent.id]!, ...(body.name ? { name: body.name } : {}) };
      return agents[agent.id]!;
    },
    usageCalls: [] as string[],
    async usage(groupBy: 'agent' | 'day', from: string, to: string) {
      platform.usageCalls.push(`${groupBy} ${from}..${to}`);
      if (groupBy === 'day')
        return [
          {
            day: to,
            requests: 3,
            inputTokens: 30,
            outputTokens: 60,
            costUsd: 0,
            unpricedRequests: 3,
          },
        ];
      return [
        {
          agentId: TIM_AGENT,
          requests: 2,
          inputTokens: 20,
          outputTokens: 40,
          costUsd: 0,
          unpricedRequests: 2,
        },
        {
          agentId: BOB_AGENT,
          requests: 1,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0,
          unpricedRequests: 1,
        },
      ];
    },
    async deleteAgent(id: string) {
      deleted.push(id);
      delete agents[id];
    },
    async fetch(path: string, init: RequestInit = {}) {
      relayed.push(`${init.method ?? 'GET'} ${path}`);
      if (path.endsWith('/events'))
        // A stream that stays open, as a conversation's does.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: view\ndata: {}\n\n'));
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      return Response.json({ data: [] });
    },
  };
  return platform;
}

let platform: ReturnType<typeof fakePlatform>;
let app: ReturnType<typeof createApp>;
let store: MemoryStore;
beforeEach(() => {
  platform = fakePlatform();
  store = new MemoryStore();
  app = createApp(config, { store, platform: platform as unknown as Platform });
});

/** Signs in as a development account; returns its cookie and CSRF token. */
async function signIn(account: 'tim' | 'bob') {
  const response = await app.request('/auth/dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5177' },
    body: JSON.stringify({ account }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const me = await (await app.request('/api/me', { headers: { Cookie: cookie } })).json();
  return { cookie, csrf: me.data.csrfToken as string };
}

describe('agent ownership', () => {
  it('lists only the person’s own assistant, named by the app', async () => {
    const { cookie } = await signIn('tim');
    const body = await (await app.request('/api/agents', { headers: { Cookie: cookie } })).json();
    expect(body.data.map((agent: PlatformAgent) => agent.id)).toEqual([TIM_AGENT]);
    expect(body.data[0].name).toBe('Assistant');
  });

  it('relays requests for the person’s own agent', async () => {
    const { cookie } = await signIn('tim');
    const response = await app.request(`/api/agents/${TIM_AGENT}/threads`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(platform.relayed).toEqual([`GET /v1/agents/${TIM_AGENT}/threads`]);
  });

  it('refuses another person’s agent as not found, and relays nothing', async () => {
    const { cookie, csrf } = await signIn('tim');
    for (const [method, path] of [
      ['GET', `/api/agents/${BOB_AGENT}/threads`],
      ['GET', `/api/agents/${BOB_AGENT}/threads/t1`],
      ['GET', `/api/agents/${BOB_AGENT}/threads/t1/events`],
      ['POST', `/api/agents/${BOB_AGENT}/threads/t1/messages`],
      ['POST', `/api/agents/${BOB_AGENT}/threads/t1/stop`],
      ['DELETE', `/api/agents/${BOB_AGENT}/threads/t1`],
      ['PATCH', `/api/agents/${BOB_AGENT}/threads/t1`],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://localhost:5177' },
        body:
          method === 'POST' ? '{"text":"hi"}' : method === 'PATCH' ? '{"title":"x"}' : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(platform.relayed).toEqual([]);
  });

  it('refuses malformed agent and thread IDs', async () => {
    const { cookie } = await signIn('tim');
    expect(
      (await app.request('/api/agents/../v1/teams/threads', { headers: { Cookie: cookie } }))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/api/agents/${TIM_AGENT}/threads/a%2Fb`, { headers: { Cookie: cookie } }))
        .status,
    ).toBe(400);
    expect(platform.relayed).toEqual([]);
  });

  it('matches agent keys exactly, not by a shared prefix', () => {
    expect(ownsAgent(tim, { externalKey: `u:${tim.id}` })).toBe(true);
    expect(ownsAgent(tim, { externalKey: `u:${tim.id}:coder` })).toBe(true);
    expect(ownsAgent(tim, { externalKey: `u:${tim.id}x` })).toBe(false);
    expect(ownsAgent(tim, { externalKey: null })).toBe(false);
  });
});

describe('optional features and usage', () => {
  // Tim is the instance's first administrator.
  const withAdmin = { ...config, initialAdminEmail: 'tim@example.test' };
  beforeEach(() => {
    app = createApp(withAdmin, { store, platform: platform as unknown as Platform });
  });
  const admin = () => signIn('tim');

  it('tells everyone which features are on', async () => {
    const { cookie } = await signIn('bob');
    const me = await (await app.request('/api/me', { headers: { Cookie: cookie } })).json();
    expect(me.data.features).toEqual({ usage: true });
  });

  it('shows administrators usage per person, and nobody else', async () => {
    const bob = await signIn('bob');
    expect(
      (await app.request('/api/admin/usage', { headers: { Cookie: bob.cookie } })).status,
    ).toBe(403);
    const { cookie } = await admin();
    const response = await app.request('/api/admin/usage?days=7', { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()).data;
    expect(body.days).toBe(7);
    expect(
      body.people.map((p: { name: string; requests: number }) => [p.name, p.requests]),
    ).toEqual([
      ['Tim', 2],
      ['Bob', 1],
    ]);
    expect(body.byDay).toHaveLength(7);
  });

  it('refuses usage once an administrator turns it off, and records who did', async () => {
    const { cookie, csrf } = await admin();
    const off = await app.request('/api/admin/settings/features', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        Origin: 'http://localhost:5177',
        'Content-Type': 'application/json',
      },
      body: '{"usage":false}',
    });
    expect(off.status).toBe(200);
    expect((await app.request('/api/admin/usage', { headers: { Cookie: cookie } })).status).toBe(
      404,
    );
    const me = await (await app.request('/api/me', { headers: { Cookie: cookie } })).json();
    expect(me.data.features.usage).toBe(false);
    const audit = await (
      await app.request('/api/admin/audit', { headers: { Cookie: cookie } })
    ).json();
    expect(
      audit.data.some((entry: { action: string }) => entry.action === 'settings.features'),
    ).toBe(true);
  });

  it('keeps a feature the deployment disables off, whatever administrators choose', async () => {
    const locked = createApp(
      { ...withAdmin, disabledFeatures: ['usage'] },
      { store, platform: platform as unknown as Platform },
    );
    const response = await locked.request('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5177' },
      body: '{"account":"tim"}',
    });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const list = await (
      await locked.request('/api/admin/features', { headers: { Cookie: cookie } })
    ).json();
    expect(list.data[0]).toMatchObject({ id: 'usage', enabled: false, locked: true });
    expect((await locked.request('/api/admin/usage', { headers: { Cookie: cookie } })).status).toBe(
      404,
    );
  });
});

describe('renaming a conversation', () => {
  const rename = (cookie: string, csrf: string, body: string) =>
    app.request(`/api/agents/${TIM_AGENT}/threads/t1`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        Origin: 'http://localhost:5177',
        'Content-Type': 'application/json',
      },
      body,
    });

  it('passes a tidied title to the platform', async () => {
    const { cookie, csrf } = await signIn('tim');
    expect((await rename(cookie, csrf, '{"title":"  Trip\\n plans  "}')).status).toBe(200);
    expect(platform.relayed).toEqual([`PATCH /v1/agents/${TIM_AGENT}/threads/t1`]);
  });

  it('refuses an empty or too long title, and relays nothing', async () => {
    const { cookie, csrf } = await signIn('tim');
    for (const body of [
      '{"title":"   "}',
      '{}',
      'nope',
      JSON.stringify({ title: 'x'.repeat(201) }),
    ])
      expect((await rename(cookie, csrf, body)).status, body).toBe(400);
    expect(platform.relayed).toEqual([]);
  });
});

describe('sessions and writes', () => {
  it('requires a session', async () => {
    expect((await app.request('/api/agents')).status).toBe(401);
    expect(await (await app.request('/api/me?optional=true')).json()).toEqual({ data: null });
  });

  it('rejects a forged or tampered session cookie', async () => {
    const { cookie } = await signIn('tim');
    const tampered = `${cookie.slice(0, -4)}AAAA`;
    expect((await app.request('/api/agents', { headers: { Cookie: tampered } })).status).toBe(401);
  });

  it('requires the CSRF token and this app’s origin on writes', async () => {
    const { cookie, csrf } = await signIn('tim');
    const send = (headers: Record<string, string>) =>
      app.request(`/api/agents/${TIM_AGENT}/threads/t1/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
        body: '{"text":"hi"}',
      });
    expect((await send({})).status).toBe(403);
    expect((await send({ 'X-CSRF-Token': 'wrong' })).status).toBe(403);
    expect((await send({ 'X-CSRF-Token': csrf, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send({ 'X-CSRF-Token': csrf, Origin: 'http://localhost:5177' })).status).toBe(
      200,
    );
    expect(platform.relayed).toEqual([`POST /v1/agents/${TIM_AGENT}/threads/t1/messages`]);
  });

  it('refuses development sign-in from another origin or when it is off', async () => {
    const cross = await app.request('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{"account":"tim"}',
    });
    expect(cross.status).toBe(403);
    const off = createApp(
      { ...config, devAuth: false },
      { store: new MemoryStore(), platform: platform as unknown as Platform },
    );
    const response = await off.request('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"account":"tim"}',
    });
    expect(response.status).toBe(404);
  });
});

describe('streams', () => {
  const open = (cookie: string, thread: string) =>
    app.request(`/api/agents/${TIM_AGENT}/threads/${thread}/events`, {
      headers: { Cookie: cookie },
    });

  it('caps how many conversation streams one person holds open, and frees a slot when one closes', async () => {
    const { cookie } = await signIn('tim');
    const held = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
      const response = await open(cookie, `t${i}`);
      expect(response.status).toBe(200);
      held.push(response);
    }
    expect((await open(cookie, 'more')).status).toBe(429);

    await held[0]!.body!.cancel();
    const again = await open(cookie, 'again');
    expect(again.status).toBe(200);
    await again.body!.cancel();
    for (const response of held.slice(1)) await response.body!.cancel();
  });

  it('counts streams per person', async () => {
    const tim = await signIn('tim');
    const bob = await signIn('bob');
    const held = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) held.push(await open(tim.cookie, `t${i}`));
    const own = await app.request(`/api/agents/${BOB_AGENT}/threads/t1/events`, {
      headers: { Cookie: bob.cookie },
    });
    expect(own.status).toBe(200);
    await own.body!.cancel();
    for (const response of held) await response.body!.cancel();
  });

  it('ends a stream cleanly when the platform drops it', async () => {
    let ended = 0;
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\n'));
      },
      pull() {
        throw new TypeError('terminated');
      },
    });
    const reader = tolerant(broken, () => ended++).getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(true); // closed, not an error
    expect(ended).toBe(1);
  });

  it("streams the person's conversation events, and only with a session", async () => {
    expect((await app.request('/api/events')).status).toBe(401);
    const { cookie } = await signIn('tim');
    const response = await app.request('/api/events', { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe('event: ready\ndata: {}\n\n');
    await reader.cancel();
  });

  it('caps event streams per person (tabs)', async () => {
    const { cookie } = await signIn('tim');
    const held = [];
    for (let i = 0; i < MAX_EVENT_STREAMS_PER_USER; i++)
      held.push(await app.request('/api/events', { headers: { Cookie: cookie } }));
    expect((await app.request('/api/events', { headers: { Cookie: cookie } })).status).toBe(429);
    await held[0]!.body!.cancel();
    const again = await app.request('/api/events', { headers: { Cookie: cookie } });
    expect(again.status).toBe(200);
    await again.body!.cancel();
    for (const response of held.slice(1)) await response.body!.cancel();
  });

  it('never caches API answers', async () => {
    const response = await app.request('/api/me?optional=true');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('roles', () => {
  let store: MemoryStore;
  const as = async (account: 'tim' | 'bob') => {
    const response = await app.request('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5177' },
      body: JSON.stringify({ account }),
    });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const me = await (await app.request('/api/me', { headers: { Cookie: cookie } })).json();
    const headers = {
      Cookie: cookie,
      'X-CSRF-Token': me.data.csrfToken,
      Origin: 'http://localhost:5177',
      'Content-Type': 'application/json',
    };
    return { cookie, headers, me: me.data };
  };
  const patch = (headers: Record<string, string>, id: string, body: unknown) =>
    app.request(`/api/admin/people/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    store = new MemoryStore();
    app = createApp(
      { ...config, initialAdminEmail: 'tim@example.test' },
      { store, platform: platform as unknown as Platform },
    );
  });

  it('makes the initial admin an administrator, and says so in /api/me', async () => {
    expect((await as('tim')).me.user.role).toBe('admin');
    expect((await as('bob')).me.user.role).toBe('user');
  });

  it('keeps administration to administrators', async () => {
    const bob = await as('bob');
    expect(
      (await app.request('/api/admin/people', { headers: { Cookie: bob.cookie } })).status,
    ).toBe(403);
    const tim = await as('tim');
    const people = await (
      await app.request('/api/admin/people', { headers: { Cookie: tim.cookie } })
    ).json();
    expect(people.data.map((person: { email: string }) => person.email).sort()).toEqual([
      'bob@example.test',
      'tim@example.test',
    ]);
  });

  it('promotes, and the new role applies to the person’s next request', async () => {
    const tim = await as('tim');
    const bob = await as('bob');
    expect((await patch(tim.headers, bob.me.user.id, { role: 'admin' })).status).toBe(200);
    expect(
      (await app.request('/api/admin/people', { headers: { Cookie: bob.cookie } })).status,
    ).toBe(200);
  });

  it('signs a suspended person out at once, and refuses them sign-in', async () => {
    const tim = await as('tim');
    const bob = await as('bob');
    expect((await patch(tim.headers, bob.me.user.id, { status: 'suspended' })).status).toBe(200);
    const after = await app.request('/api/agents', { headers: { Cookie: bob.cookie } });
    expect(after.status).toBe(401); // the suspension ended the session
    const again = await app.request('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5177' },
      body: JSON.stringify({ account: 'bob' }),
    });
    expect(again.status).toBe(403);
    expect((await again.json()).error.code).toBe('suspended');
  });

  it('never leaves no administrator, and an admin cannot suspend themselves', async () => {
    const tim = await as('tim');
    const demote = await patch(tim.headers, tim.me.user.id, { role: 'user' });
    expect(demote.status).toBe(409);
    expect((await demote.json()).error.code).toBe('last_admin');
    expect((await patch(tim.headers, tim.me.user.id, { status: 'suspended' })).status).toBe(400);
  });

  it('refuses nonsense', async () => {
    const tim = await as('tim');
    expect((await patch(tim.headers, tim.me.user.id, { role: 'owner' })).status).toBe(400);
    expect((await patch(tim.headers, 'nobody', { role: 'admin' })).status).toBe(404);
  });

  it('signs out everywhere: every session of the person ends', async () => {
    const one = await as('bob');
    const two = await as('bob');
    expect(
      (await app.request('/api/me/sign-out-everywhere', { method: 'POST', headers: one.headers }))
        .status,
    ).toBe(200);
    expect((await app.request('/api/agents', { headers: { Cookie: two.cookie } })).status).toBe(
      401,
    );
    expect(
      (await app.request('/api/me?optional=true', { headers: { Cookie: one.cookie } })).status,
    ).toBe(200);
  });

  it('records changes in the audit log', async () => {
    const tim = await as('tim');
    const bob = await as('bob');
    await patch(tim.headers, bob.me.user.id, { role: 'admin' });
    const audit = await (
      await app.request('/api/admin/audit', { headers: { Cookie: tim.cookie } })
    ).json();
    expect(audit.data[0]).toMatchObject({
      action: 'person.role',
      actorId: tim.me.user.id,
      targetId: bob.me.user.id,
    });
  });
});

describe('preferences', () => {
  it('saves and reads back a person’s own preferences, and only known ones', async () => {
    const { cookie, csrf } = await signIn('tim');
    const headers = {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      Origin: 'http://localhost:5177',
      'Content-Type': 'application/json',
    };
    const put = (key: string, body: string) =>
      app.request(`/api/me/prefs/${key}`, { method: 'PUT', headers, body });
    expect((await put('appearance', JSON.stringify({ value: { theme: 'light' } }))).status).toBe(
      200,
    );
    const read = await (await app.request('/api/me/prefs', { headers: { Cookie: cookie } })).json();
    expect(read.data).toEqual({ appearance: { theme: 'light' } });
    expect((await put('secrets', JSON.stringify({ value: {} }))).status).toBe(404);
    expect((await put('appearance', JSON.stringify({ value: 'light' }))).status).toBe(400);
    expect(
      (await put('appearance', JSON.stringify({ value: { x: 'y'.repeat(5000) } }))).status,
    ).toBe(413);
    // Writes need the CSRF token, as everywhere.
    const forged = await app.request('/api/me/prefs/appearance', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: {} }),
    });
    expect(forged.status).toBe(403);
  });

  it('keeps people’s preferences apart', async () => {
    const tim = await signIn('tim');
    await app.request('/api/me/prefs/appearance', {
      method: 'PUT',
      headers: { Cookie: tim.cookie, 'X-CSRF-Token': tim.csrf, Origin: 'http://localhost:5177' },
      body: JSON.stringify({ value: { theme: 'light' } }),
    });
    const bob = await signIn('bob');
    expect(
      (await (await app.request('/api/me/prefs', { headers: { Cookie: bob.cookie } })).json()).data,
    ).toEqual({});
  });
});

describe('branding and overview', () => {
  let tim: { headers: Record<string, string>; cookie: string };
  beforeEach(async () => {
    app = createApp(
      { ...config, initialAdminEmail: 'tim@example.test' },
      { store: new MemoryStore(), platform: platform as unknown as Platform },
    );
    const { cookie, csrf } = await signIn('tim');
    tim = {
      cookie,
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        Origin: 'http://localhost:5177',
        'Content-Type': 'application/json',
      },
    };
  });
  const put = (body: unknown) =>
    app.request('/api/admin/settings/branding', {
      method: 'PUT',
      headers: tim.headers,
      body: JSON.stringify(body),
    });

  it('starts from the defaults and shows saved branding to everyone, signed in or not', async () => {
    const before = await (await app.request('/api/auth/config')).json();
    expect(before.data.instance).toMatchObject({
      name: 'Pi Agents',
      logoUrl: null,
      colorTheme: 'neutral',
      defaultTheme: 'dark',
    });
    const saved = await put({
      name: 'Acme Agents',
      logoUrl: 'https://acme.example/logo.svg',
      colorTheme: 'violet',
      defaultTheme: 'light',
    });
    expect(saved.status).toBe(200);
    const after = await (await app.request('/api/auth/config')).json();
    expect(after.data.instance).toMatchObject({
      name: 'Acme Agents',
      logoUrl: 'https://acme.example/logo.svg',
      colorTheme: 'violet',
      defaultTheme: 'light',
    });
  });

  it('refuses unsafe logos and bad values, naming each field', async () => {
    const response = await put({
      name: '',
      logoUrl: 'javascript:alert(1)',
      colorTheme: 'pink',
      defaultTheme: 'sepia',
    });
    expect(response.status).toBe(400);
    expect(Object.keys((await response.json()).error.details).sort()).toEqual([
      'colorTheme',
      'defaultTheme',
      'logoUrl',
      'name',
    ]);
    for (const logoUrl of [
      'http://acme.example/logo.svg',
      '//evil.example/x.png',
      'https://user:pw@acme.example/x.png',
    ]) {
      expect(
        (await put({ name: 'A', logoUrl, colorTheme: 'blue', defaultTheme: 'dark' })).status,
        logoUrl,
      ).toBe(400);
    }
    expect(
      (
        await put({
          name: 'A',
          logoUrl: '/brand/logo.svg',
          colorTheme: 'blue',
          defaultTheme: 'dark',
        })
      ).status,
    ).toBe(200);
  });

  it('keeps branding and the overview to administrators', async () => {
    const bob = await signIn('bob');
    const asBob = { Cookie: bob.cookie, 'X-CSRF-Token': bob.csrf, Origin: 'http://localhost:5177' };
    expect((await app.request('/api/admin/overview', { headers: asBob })).status).toBe(403);
    expect(
      (
        await app.request('/api/admin/settings/branding', {
          method: 'PUT',
          headers: asBob,
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const overview = await (
      await app.request('/api/admin/overview', { headers: { Cookie: tim.cookie } })
    ).json();
    expect(overview.data).toMatchObject({ people: 2, admins: 1, suspended: 0, activeToday: 2 });
  });
});

describe('agents', () => {
  const json = (headers: Record<string, string>) => ({
    ...headers,
    'Content-Type': 'application/json',
  });
  const as = async (account: 'tim' | 'bob') => {
    const { cookie, csrf } = await signIn(account);
    return { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://localhost:5177' };
  };
  const list = async (headers: Record<string, string>) =>
    (await (await app.request('/api/agents', { headers })).json()).data as {
      id: string;
      name: string;
      kind: string;
    }[];
  const make = (headers: Record<string, string>, body: unknown) =>
    app.request('/api/agents', {
      method: 'POST',
      headers: json(headers),
      body: JSON.stringify(body),
    });

  it('gives everyone the built-in assistant, named by the app', async () => {
    const tim = await as('tim');
    expect(await list(tim)).toEqual([
      expect.objectContaining({ id: TIM_AGENT, name: 'Assistant', kind: 'provided' }),
    ]);
  });

  it('makes a person their own agent from an allowed template, and lists it', async () => {
    const tim = await as('tim');
    const response = await make(tim, {
      name: 'Code helper',
      templateId: 't-coder',
      modelId: 'gpt-oss-120b',
    });
    expect(response.status).toBe(201);
    const agent = (await response.json()).data;
    expect(agent).toMatchObject({ name: 'Code helper', kind: 'personal' });
    expect(platform.created.at(-1)).toMatchObject({ templateId: 't-coder', modelId: 'm-oss' });
    expect(platform.created.at(-1)!.key).toMatch(/^u:[0-9a-f]+:p:/);
    expect((await list(tim)).map((each) => each.name)).toEqual(['Assistant', 'Code helper']);
  });

  it('refuses names, templates and models that are not allowed', async () => {
    const tim = await as('tim');
    expect((await make(tim, { name: '', templateId: 't-coder' })).status).toBe(400);
    expect((await make(tim, { name: 'X', templateId: 't-nope' })).status).toBe(400);
    expect((await make(tim, { name: 'X', templateId: 't-coder', modelId: 'm-nope' })).status).toBe(
      400,
    );
  });

  it('keeps a person to the limit', async () => {
    const tim = await as('tim');
    for (let i = 0; i < 5; i++)
      expect((await make(tim, { name: `A${i}`, templateId: 't-coder' })).status).toBe(201);
    const sixth = await make(tim, { name: 'A5', templateId: 't-coder' });
    expect(sixth.status).toBe(409);
    expect((await sixth.json()).error.code).toBe('limit');
  });

  it('renames and deletes a person’s own agent, but not a provided one or another person’s', async () => {
    const tim = await as('tim');
    const bob = await as('bob');
    const mine = (await (await make(tim, { name: 'Helper', templateId: 't-coder' })).json()).data;
    const renamed = await app.request(`/api/agents/${mine.id}`, {
      method: 'PATCH',
      headers: json(tim),
      body: JSON.stringify({ name: 'Better helper' }),
    });
    expect((await renamed.json()).data.name).toBe('Better helper');
    expect(
      (await app.request(`/api/agents/${mine.id}`, { method: 'DELETE', headers: bob })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/agents/${TIM_AGENT}`, { method: 'DELETE', headers: tim })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/agents/${mine.id}`, { method: 'DELETE', headers: tim })).status,
    ).toBe(200);
    expect(platform.deleted).toEqual([mine.id]);
    expect((await list(tim)).map((each) => each.name)).toEqual(['Assistant']);
  });

  it('gives everyone each provided agent an administrator adds', async () => {
    app = createApp(
      { ...config, initialAdminEmail: 'tim@example.test' },
      { store: new MemoryStore(), platform: platform as unknown as Platform },
    );
    const tim = await as('tim');
    const saved = await app.request('/api/admin/settings/provided', {
      method: 'PUT',
      headers: json(tim),
      body: JSON.stringify({
        agents: [
          { id: 'assistant', name: 'Assistant', description: '', templateId: null, modelId: null },
          {
            id: 'hr',
            name: 'HR Helper',
            description: 'Benefits and leave',
            templateId: 't-assistant',
            modelId: 'm-luna',
          },
        ],
      }),
    });
    expect(saved.status).toBe(200);
    const bob = await as('bob');
    const bobs = await list(bob);
    expect(bobs.map((each) => each.name)).toEqual(['Assistant', 'HR Helper']);
    expect(platform.created.find((each) => each.key.endsWith(':m:hr'))).toMatchObject({
      templateId: 't-assistant',
      modelId: 'm-luna',
    });
    // The built-in assistant cannot be removed.
    const removed = await app.request('/api/admin/settings/provided', {
      method: 'PUT',
      headers: json(tim),
      body: JSON.stringify({
        agents: [{ id: 'hr', name: 'HR', description: '', templateId: null, modelId: null }],
      }),
    });
    expect(removed.status).toBe(400);
  });

  it('lets administrators turn model choice off and set the limit, within what the platform offers', async () => {
    app = createApp(
      { ...config, initialAdminEmail: 'tim@example.test' },
      { store: new MemoryStore(), platform: platform as unknown as Platform },
    );
    const tim = await as('tim');
    const put = (body: unknown) =>
      app.request('/api/admin/settings/agents', {
        method: 'PUT',
        headers: json(tim),
        body: JSON.stringify(body),
      });
    expect(
      (
        await put({
          defaultModelId: 'm-nope',
          personalLimit: 5,
          allowModelChoice: true,
          allowedTemplateIds: null,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          defaultModelId: 'm-oss',
          personalLimit: 1,
          allowModelChoice: false,
          allowedTemplateIds: ['t-coder'],
        })
      ).status,
    ).toBe(200);
    const catalog = (await (await app.request('/api/agents/catalog', { headers: tim })).json())
      .data;
    expect(catalog).toMatchObject({
      allowModelChoice: false,
      limit: 1,
      models: [],
      defaultModelId: 'm-oss',
    });
    expect(catalog.templates.map((template: { id: string }) => template.id)).toEqual(['t-coder']);
    // The model asked for is ignored when choice is off: the default is used.
    await make(tim, { name: 'One', templateId: 't-coder', modelId: 'm-luna' });
    expect(platform.created.at(-1)).toMatchObject({ modelId: 'm-oss' });
    expect((await make(tim, { name: 'Two', templateId: 't-coder' })).status).toBe(409);
  });
});
