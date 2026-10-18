// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import type { Config } from '../../server/config.ts';
import {
  agentKeyFor,
  ownsAgent,
  type Platform,
  type PlatformAgent,
} from '../../server/platform.ts';
import { userIdFor } from '../../server/session.ts';

const config: Config = {
  appUrl: new URL('http://localhost:5177'),
  port: 0,
  platformUrl: new URL('http://localhost:8098'),
  platformTeam: 'pai',
  platformServiceKey: 'pdp_sa_test',
  agentTemplate: '',
  agentName: 'Assistant',
  sessionSecret: 'x'.repeat(40),
  sessionTtlSeconds: 3600,
  oidc: null,
  devAuth: true,
  staticDir: null,
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
  const platform = {
    relayed,
    async ensureAssistant(user: { id: string }) {
      return Object.values(agents).find((agent) => agent.externalKey === `u:${user.id}`)!;
    },
    async isOwnAgent(user: typeof tim, agentId: string) {
      const agent = agents[agentId];
      return agent ? ownsAgent(user, agent) : false;
    },
    async fetch(path: string, init: RequestInit = {}) {
      relayed.push(`${init.method ?? 'GET'} ${path}`);
      return Response.json({ data: [] });
    },
  };
  return platform;
}

let platform: ReturnType<typeof fakePlatform>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  platform = fakePlatform();
  app = createApp(config, platform as unknown as Platform);
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
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://localhost:5177' },
        body: method === 'POST' ? '{"text":"hi"}' : undefined,
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
    const off = createApp({ ...config, devAuth: false }, platform as unknown as Platform);
    const response = await off.request('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"account":"tim"}',
    });
    expect(response.status).toBe(404);
  });
});
