// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import { type Config, loadConfig } from '../../server/config.ts';
import { Metrics, Registry } from '../../server/metrics.ts';
import type { Platform } from '../../server/platform.ts';
import { MemoryStore } from '../../server/store.ts';

describe('the registry', () => {
  it('writes counters, gauges and histograms in the Prometheus text format', async () => {
    const r = new Registry();
    const c = r.counter('things_total', 'Things done.');
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' }, 2);
    c.inc({ kind: 'b' });
    r.gauge('level', 'A level.', () => 7);
    r.gauge('shelf', 'By shelf.', () => [
      { labels: { name: 'x' }, value: 1 },
      { labels: { name: 'y' }, value: 2.5 },
    ]);
    const h = r.histogram('wait_seconds', 'Waiting.', [0.1, 1]);
    h.observe(0.05, { route: '/r' });
    h.observe(0.5, { route: '/r' });
    h.observe(5, { route: '/r' });
    expect(await r.render()).toBe(
      [
        '# HELP things_total Things done.',
        '# TYPE things_total counter',
        'things_total{kind="a"} 3',
        'things_total{kind="b"} 1',
        '# HELP level A level.',
        '# TYPE level gauge',
        'level 7',
        '# HELP shelf By shelf.',
        '# TYPE shelf gauge',
        'shelf{name="x"} 1',
        'shelf{name="y"} 2.5',
        '# HELP wait_seconds Waiting.',
        '# TYPE wait_seconds histogram',
        'wait_seconds_bucket{le="0.1",route="/r"} 1',
        'wait_seconds_bucket{le="1",route="/r"} 2',
        'wait_seconds_bucket{le="+Inf",route="/r"} 3',
        'wait_seconds_sum{route="/r"} 5.55',
        'wait_seconds_count{route="/r"} 3',
        '',
      ].join('\n'),
    );
  });

  it('escapes label values, leaves out a family with nothing, and survives a gauge that throws', async () => {
    const r = new Registry();
    r.counter('empty_total', 'No samples yet.');
    r.counter('quoted_total', 'Quotes.').inc({ v: 'a"b\\c\nd' });
    r.gauge('broken', 'Fails.', () => {
      throw new Error('no');
    });
    const text = await r.render();
    expect(text).toContain('quoted_total{v="a\\"b\\\\c\\nd"} 1');
    expect(text).not.toContain('empty_total');
    expect(text).not.toContain('broken');
  });
});

describe('what the app counts', () => {
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
  const platform = {
    async fetch() {
      return Response.json({ data: [] });
    },
  } as unknown as Platform;

  it('counts requests by route pattern, never by the path or the person', async () => {
    const metrics = new Metrics('9.9.9');
    const app = createApp(config, { store: new MemoryStore(), platform, metrics });
    await app.request('/healthz');
    await app.request('/healthz');
    const signedIn = await app.request('/auth/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:5177' },
      body: JSON.stringify({ account: 'tim' }),
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .find((c) => c.startsWith('pai_session='))!
      .split(';')[0]!;
    await app.request('/api/agents/some-agent-id/threads/some-thread-id', {
      headers: { Cookie: cookie },
    });
    await app.request('/api/agents/some-agent-id', { headers: { Cookie: '' } });
    await app.request('/no/such/page/123');
    const text = await metrics.render();
    expect(text).toContain('pai_http_requests_total{method="GET",route="/healthz",status="200"} 2');
    expect(text).toMatch(/route="\/api\/agents\/:\w+\/threads\/:\w+",status="\d+"\} 1/);
    expect(text).toContain('route="other",status="401"');
    expect(text).toContain('route="other",status="404"');
    expect(text).not.toContain('some-agent-id');
    expect(text).not.toContain('/no/such/page');
    expect(text).toContain(
      'pai_http_request_duration_seconds_count{method="GET",route="/healthz"} 2',
    );
    expect(text).toContain('pai_build_info{version="9.9.9"} 1');
    expect(text).toContain('pai_database_up 1');
    expect(text).toContain('process_resident_memory_bytes');
  });

  it('counts sign-ins by outcome, and the streams open', async () => {
    const metrics = new Metrics();
    const store = new MemoryStore();
    const app = createApp(config, { store, platform, metrics });
    const signIn = (account: string) =>
      app.request('/auth/dev', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'http://localhost:5177' },
        body: JSON.stringify({ account }),
      });
    expect((await signIn('tim')).status).toBe(200);
    expect((await signIn('bob')).status).toBe(200);
    const people = await store.people();
    await store.updatePerson(
      people.find((p) => p.email.startsWith('bob'))!.id,
      { status: 'suspended' },
      null,
    );
    expect((await signIn('bob')).status).toBe(403);
    const text = await metrics.render();
    expect(text).toContain('pai_sign_ins_total{outcome="ok"} 2');
    expect(text).toContain('pai_sign_ins_total{outcome="suspended"} 1');
    expect(text).toContain('pai_open_streams{kind="conversation"} 0');
    expect(text).toContain('pai_open_streams{kind="events"} 0');
  });
});

describe('METRICS_* settings', () => {
  const env = {
    APP_URL: 'https://chat.example.com',
    PLATFORM_URL: 'https://agents.example.com',
    PLATFORM_TEAM: 'pai',
    PLATFORM_SERVICE_KEY: 'pdp_sa_x',
    SESSION_SECRET: 'x'.repeat(40),
    OIDC_ISSUER: 'https://auth.example.com/',
    OIDC_CLIENT_ID: 'pai',
    OIDC_CLIENT_SECRET: 's',
    DATABASE_URL: 'postgres://x@db/pai',
  };
  it('are off unless asked for, and then on their own port', () => {
    expect(loadConfig(env as NodeJS.ProcessEnv).metrics).toBeNull();
    expect(loadConfig({ ...env, METRICS_ENABLED: 'true' } as NodeJS.ProcessEnv).metrics).toEqual({
      host: '0.0.0.0',
      port: 9464,
    });
    expect(
      loadConfig({
        ...env,
        METRICS_ENABLED: 'true',
        METRICS_PORT: '9100',
        METRICS_HOST: '127.0.0.1',
      } as NodeJS.ProcessEnv).metrics,
    ).toEqual({ host: '127.0.0.1', port: 9100 });
  });
  it('refuse a port that is not one, or the app’s own', () => {
    expect(() =>
      loadConfig({ ...env, METRICS_ENABLED: 'true', METRICS_PORT: 'x' } as NodeJS.ProcessEnv),
    ).toThrow(/METRICS_PORT/);
    expect(() =>
      loadConfig({ ...env, METRICS_ENABLED: 'true', METRICS_PORT: '5178' } as NodeJS.ProcessEnv),
    ).toThrow(/differ from PORT/);
  });
});
