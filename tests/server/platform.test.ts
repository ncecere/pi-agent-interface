// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../server/config.ts';
import { Platform, type PlatformAgent } from '../../server/platform.ts';

const LUNA = 'd4049e6c-2eb1-4b6e-8d69-46707b93a969';
const HAIKU = '343f195e-411f-4ae4-95a4-012ac58b851e';
const user = { id: 'tim', name: 'Tim', email: 'tim@example.test' };

const config = (agentModel: string): Config => ({
  appUrl: new URL('http://localhost:5177'),
  host: '127.0.0.1',
  port: 0,
  platformUrl: new URL('https://agents.example.com'),
  platformTeam: 'pai',
  platformServiceKey: 'pdp_sa_test',
  agentTemplate: 'assistant',
  agentName: 'Assistant',
  agentModel,
  sessionSecret: 'x'.repeat(40),
  sessionTtlSeconds: 3600,
  oidc: null,
  devAuth: true,
  staticDir: null,
});

/** A platform with one team, its published models, and (optionally) Tim's assistant already made. */
function fakePlatform(
  options: { existing?: Partial<PlatformAgent>; patchStatus?: number; stale?: boolean } = {},
) {
  const calls: { method: string; path: string; body?: unknown; ifMatch?: string | null }[] = [];
  let agent: PlatformAgent | null = options.existing
    ? {
        id: 'a1',
        name: 'Assistant · Tim',
        description: '',
        enabled: true,
        running: false,
        revision: 4,
        model: null,
        ...options.existing,
      }
    : null;
  let stale = options.stale ?? false;
  const reply = (data: unknown, status = 200) =>
    Response.json(status < 400 ? { data } : { error: { code: 'x', message: 'x' } }, { status });
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname,
      body,
      ifMatch: new Headers(init.headers).get('If-Match'),
    });
    if (url.pathname === '/v1/teams/pai/models')
      return reply([
        { id: HAIKU, name: 'claude-haiku-5-5', enabled: true },
        { id: LUNA, name: 'gpt-6-luna', enabled: true },
        { id: 'off', name: 'retired-model', enabled: false },
      ]);
    if (method === 'PUT' && url.pathname.startsWith('/v1/teams/pai/agents/by-key/')) {
      agent ??= {
        id: 'a1',
        name: body.name,
        description: '',
        enabled: true,
        running: false,
        revision: 1,
        model: body.modelId
          ? { id: body.modelId, name: 'm', source: 'agent', available: true }
          : null,
      };
      return reply(agent, agent.revision === 1 ? 201 : 200);
    }
    if (url.pathname === '/v1/agents/a1' && method === 'GET') return reply(agent);
    if (url.pathname === '/v1/agents/a1' && method === 'PATCH') {
      if (options.patchStatus) return reply(null, options.patchStatus);
      if (stale) {
        // Someone else changed it first.
        stale = false;
        agent = { ...agent!, revision: agent!.revision! + 1 };
        return reply(null, 412);
      }
      if (new Headers(init.headers).get('If-Match') !== `"${agent!.revision}"`)
        return reply(null, 412);
      agent = {
        ...agent!,
        revision: agent!.revision! + 1,
        model: { id: body.modelId, name: 'm', source: 'agent', available: true },
      };
      return reply(agent);
    }
    return reply(null, 404);
  });
  return { calls, agent: () => agent };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('AGENT_MODEL', () => {
  it('creates a new assistant on the model, found by name', async () => {
    const fake = fakePlatform();
    const agent = await new Platform(config('gpt-6-luna')).ensureAssistant(user);
    expect(agent.model?.id).toBe(LUNA);
    const put = fake.calls.find((call) => call.method === 'PUT');
    expect(put?.body).toMatchObject({ modelId: LUNA, template: 'assistant' });
    expect(fake.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('moves an existing assistant onto the model, with its revision', async () => {
    const fake = fakePlatform({ existing: { model: null, revision: 4 } });
    const agent = await new Platform(config('gpt-6-luna')).ensureAssistant(user);
    expect(agent.model?.id).toBe(LUNA);
    const patch = fake.calls.find((call) => call.method === 'PATCH');
    expect(patch).toMatchObject({ path: '/v1/agents/a1', body: { modelId: LUNA }, ifMatch: '"4"' });
  });

  it('also moves an assistant that is on another model', async () => {
    fakePlatform({
      existing: {
        model: { id: HAIKU, name: 'claude-haiku-5-5', source: 'agent', available: true },
      },
    });
    expect((await new Platform(config(LUNA)).ensureAssistant(user)).model?.id).toBe(LUNA);
  });

  it('leaves an assistant already on the model alone', async () => {
    const fake = fakePlatform({
      existing: { model: { id: LUNA, name: 'gpt-6-luna', source: 'agent', available: true } },
    });
    await new Platform(config('gpt-6-luna')).ensureAssistant(user);
    expect(fake.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('tries once more from the latest revision when the agent changed in the meantime', async () => {
    const fake = fakePlatform({ existing: { model: null, revision: 4 }, stale: true });
    const agent = await new Platform(config('gpt-6-luna')).ensureAssistant(user);
    expect(agent.model?.id).toBe(LUNA);
    expect(
      fake.calls.filter((call) => call.method === 'PATCH').map((call) => call.ifMatch),
    ).toEqual(['"4"', '"5"']);
  });

  it('never keeps a person out of their assistant when the model cannot be changed', async () => {
    const fake = fakePlatform({ existing: { model: null }, patchStatus: 403 });
    const platform = new Platform(config('gpt-6-luna'));
    const agent = await platform.ensureAssistant(user);
    expect(agent.id).toBe('a1');
    expect(warn).toHaveBeenCalled();
    // Not tried again on every page load.
    await platform.ensureAssistant(user);
    expect(fake.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('sets nothing when the model is not published, or disabled: such an agent would not start', async () => {
    for (const wanted of ['no-such-model', 'retired-model']) {
      const fake = fakePlatform({ existing: { model: null } });
      await new Platform(config(wanted)).ensureAssistant(user);
      expect(
        fake.calls.some((call) => call.method === 'PATCH'),
        wanted,
      ).toBe(false);
      expect(fake.calls.find((call) => call.method === 'PUT')?.body).not.toHaveProperty('modelId');
      vi.unstubAllGlobals();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a model published'));
  });

  it('leaves models to the platform when unset, without asking for the list', async () => {
    const fake = fakePlatform({ existing: { model: null } });
    await new Platform(config('')).ensureAssistant(user);
    expect(fake.calls.map((call) => call.method)).toEqual(['PUT']);
  });

  it('asks for the team’s models once, not on every page load', async () => {
    const fake = fakePlatform({
      existing: { model: { id: LUNA, name: 'gpt-6-luna', source: 'agent', available: true } },
    });
    const platform = new Platform(config('gpt-6-luna'));
    for (let i = 0; i < 5; i++) await platform.ensureAssistant(user);
    expect(fake.calls.filter((call) => call.path === '/v1/teams/pai/models')).toHaveLength(1);
  });
});
