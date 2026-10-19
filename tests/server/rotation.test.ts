// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import { type Config, loadConfig } from '../../server/config.ts';
import { resealConnections } from '../../server/connect.ts';
import type { Platform } from '../../server/platform.ts';
import { Sealer, secretsOf } from '../../server/session.ts';
import { MemoryStore } from '../../server/store.ts';

const OLD = 'o'.repeat(40);
const NEW = 'n'.repeat(40);
const OTHER = 'z'.repeat(40);

describe('Sealer', () => {
  it('seals with the first secret and opens with any', () => {
    const oldSealer = new Sealer(OLD, 'p');
    const rotated = new Sealer([NEW, OLD], 'p');
    const value = { a: 1 };
    expect(rotated.open(oldSealer.seal(value))).toEqual(value);
    expect(rotated.needsReseal(oldSealer.seal(value))).toBe(true);
    const fresh = rotated.seal(value);
    expect(rotated.needsReseal(fresh)).toBe(false);
    expect(new Sealer(NEW, 'p').open(fresh)).toEqual(value);
    // Without the previous secret, what it sealed is unreadable.
    expect(new Sealer(NEW, 'p').open(oldSealer.seal(value))).toBeNull();
    expect(new Sealer([NEW, OTHER], 'p').open(oldSealer.seal(value))).toBeNull();
  });

  it('keeps purposes apart, whatever the secret', () => {
    expect(new Sealer([NEW, OLD], 'a').open(new Sealer(OLD, 'b').seal({}))).toBeNull();
  });

  it('is not fooled by junk', () => {
    const sealer = new Sealer([NEW, OLD], 'p');
    for (const junk of [undefined, '', 'x', 'not base64 !!', 'A'.repeat(80)])
      expect(sealer.open(junk)).toBeNull();
  });
});

describe('SESSION_SECRET_PREVIOUS', () => {
  const env = {
    APP_URL: 'https://chat.example.com',
    PLATFORM_URL: 'https://agents.example.com',
    SESSION_SECRET: NEW,
    OIDC_ISSUER: 'https://auth.example.com/',
    OIDC_CLIENT_ID: 'pai',
    OIDC_CLIENT_SECRET: 's',
    DATABASE_URL: 'postgres://x@db/pai',
  };
  const load = (extra: Record<string, string>) =>
    loadConfig({ ...env, ...extra } as NodeJS.ProcessEnv);

  it('reads a list, dropping blanks, repeats and the current secret', () => {
    expect(load({}).sessionSecretPrevious).toEqual([]);
    expect(
      load({ SESSION_SECRET_PREVIOUS: ` ${OLD} , ${NEW},,${OLD}` }).sessionSecretPrevious,
    ).toEqual([OLD]);
    expect(secretsOf(load({ SESSION_SECRET_PREVIOUS: OLD }))).toEqual([NEW, OLD]);
  });

  it('refuses a weak previous secret', () => {
    expect(() => load({ SESSION_SECRET_PREVIOUS: 'short' })).toThrow(/SESSION_SECRET_PREVIOUS/);
  });
});

describe('rotating the secret', () => {
  const base = (secret: string, previous: string[] = []): Config => ({
    appUrl: new URL('http://localhost:5177'),
    host: '127.0.0.1',
    port: 0,
    platformUrl: new URL('http://localhost:8098'),
    platformTeam: 'pai',
    platformServiceKey: 'pdp_sa_test',
    agentTemplate: '',
    agentName: 'Assistant',
    agentModel: '',
    sessionSecret: secret,
    sessionSecretPrevious: previous,
    sessionTtlSeconds: 3600,
    oidc: null,
    devAuth: true,
    staticDir: null,
    databaseUrl: '',
    initialAdminEmail: null,
  });
  const platform = {
    async fetch() {
      return Response.json({ data: [] });
    },
  } as unknown as Platform;
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((line) => line.startsWith('pai_session='))
      ?.split(';')[0];

  async function signIn(config: Config, store: MemoryStore) {
    const app = createApp(config, { store, platform });
    const done = await app.request('/auth/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:5177' },
      body: JSON.stringify({ account: 'tim' }),
    });
    return cookieOf(done)!;
  }

  it('keeps people signed in while the previous secret is listed, and seals their cookie again', async () => {
    const store = new MemoryStore();
    const cookie = await signIn(base(OLD), store);
    const rotated = createApp(base(NEW, [OLD]), { store, platform });
    const me = await rotated.request('/api/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const renewed = cookieOf(me);
    expect(renewed, 'a new cookie under the current secret').toBeTruthy();
    expect(renewed).not.toBe(cookie);
    // The new cookie works with the previous secret gone; the old one no longer does.
    const final = createApp(base(NEW), { store, platform });
    expect((await final.request('/api/me', { headers: { Cookie: renewed! } })).status).toBe(200);
    expect((await final.request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('signs people out when the secret changes with no previous one listed', async () => {
    const store = new MemoryStore();
    const cookie = await signIn(base(OLD), store);
    const rotated = createApp(base(NEW), { store, platform });
    expect((await rotated.request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('seals stored platform tokens again, once, and tells what it could not read', async () => {
    const store = new MemoryStore();
    const oldTokens = new Sealer(OLD, 'platform-tokens');
    await store.signIn({ id: 'a', email: 'a@example.test', name: 'A' }, null);
    await store.signIn({ id: 'b', email: 'b@example.test', name: 'B' }, null);
    const connection = (access: string, refresh: string) => ({
      accessToken: access,
      refreshToken: refresh,
      accessExpiresAt: new Date(Date.now() + 3600_000),
      platformUserId: null,
      platformEmail: 'a@example.test',
      platformName: 'A',
      updatedAt: new Date(),
    });
    await store.saveConnection('a', connection(oldTokens.seal('at-a'), oldTokens.seal('rt-a')));
    // b's tokens were sealed with a secret nobody has any more.
    const lost = new Sealer(OTHER, 'platform-tokens');
    await store.saveConnection('b', connection(lost.seal('at-b'), lost.seal('rt-b')));

    const config = base(NEW, [OLD]);
    expect(await resealConnections(config, store)).toEqual({ resealed: 1, unreadable: 1 });
    expect(await resealConnections(config, store)).toEqual({ resealed: 0, unreadable: 1 });
    const only = new Sealer(NEW, 'platform-tokens');
    const row = await store.connection('a');
    expect(only.open(row!.accessToken)).toBe('at-a');
    expect(only.open(row!.refreshToken)).toBe('rt-a');
  });
});
