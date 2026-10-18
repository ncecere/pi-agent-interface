// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.ts';
import { type Config, DEFAULT_DEV_ACCOUNTS, loadConfig } from '../../server/config.ts';
import { userIdFor } from '../../server/session.ts';
import { MemoryStore } from '../../server/store.ts';

const ENV = {
  APP_URL: 'http://localhost:5177',
  PLATFORM_URL: 'http://localhost:8098',
  PLATFORM_AUTH: 'connect',
  SESSION_SECRET: 'x'.repeat(40),
  DATABASE_URL: 'postgres://pai:pai@127.0.0.1:5432/pai',
  DEV_AUTH: 'true',
};

const PEOPLE = [
  { id: 'priya', name: 'Priya Shah', email: 'priya.shah@example.com' },
  { id: 'alex', name: 'Alex Morgan', email: 'alex.morgan@example.com' },
];

describe('DEV_ACCOUNTS', () => {
  it('is optional: without it the config holds no accounts, and the app offers tim, bob and sally', async () => {
    const config = loadConfig({ ...ENV });
    expect(config.devAccounts).toBeUndefined();
    const app = createApp(config, { store: new MemoryStore() });
    const body = (await (await app.request('/api/auth/config')).json()) as {
      data: { devAccounts: { id: string }[] };
    };
    expect(body.data.devAccounts.map((account) => account.id)).toEqual(
      DEFAULT_DEV_ACCOUNTS.map((account) => account.id),
    );
    expect(DEFAULT_DEV_ACCOUNTS.map((account) => account.id)).toEqual(['tim', 'bob', 'sally']);
  });

  it('is a JSON array of {id, name, email}', () => {
    const config = loadConfig({ ...ENV, DEV_ACCOUNTS: JSON.stringify(PEOPLE) });
    expect(config.devAccounts).toEqual(PEOPLE);
  });

  it('is ignored unless DEV_AUTH is true', () => {
    const config = loadConfig({
      ...ENV,
      DEV_AUTH: 'false',
      OIDC_ISSUER: 'http://localhost:9000',
      OIDC_CLIENT_ID: 'pai',
      OIDC_CLIENT_SECRET: 'secret',
      DEV_ACCOUNTS: 'not json at all',
    });
    expect(config.devAuth).toBe(false);
    expect(config.devAccounts).toBeUndefined();
  });

  it('stops the server, naming the problem, when it is not usable', () => {
    const load = (value: string) => () => loadConfig({ ...ENV, DEV_ACCOUNTS: value });
    expect(load('{nope')).toThrow('DEV_ACCOUNTS is not valid JSON');
    expect(load('{}')).toThrow('DEV_ACCOUNTS must be a JSON array');
    expect(load('[]')).toThrow('with at least one account');
    expect(load('[{"id":"a b","name":"A","email":"a@example.com"}]')).toThrow(
      'DEV_ACCOUNTS[0]: id is 1 to 64',
    );
    expect(load('[{"id":"a","name":"","email":"a@example.com"}]')).toThrow(
      'DEV_ACCOUNTS[0]: name is required',
    );
    expect(load('[{"id":"a","name":"A"}]')).toThrow('DEV_ACCOUNTS[0]: email is required');
    expect(
      load(
        '[{"id":"a","name":"A","email":"a@example.com"},{"id":"a","name":"B","email":"b@example.com"}]',
      ),
    ).toThrow('the id "a" is used twice');
  });

  describe('in the app', () => {
    const config = (devAuth: boolean): Config => ({
      ...loadConfig({ ...ENV, DEV_ACCOUNTS: JSON.stringify(PEOPLE) }),
      devAuth,
    });

    it('lists the configured accounts, and only those', async () => {
      const app = createApp(config(true), { store: new MemoryStore() });
      const body = (await (await app.request('/api/auth/config')).json()) as {
        data: { devAuthEnabled: boolean; devAccounts: unknown[] };
      };
      expect(body.data.devAuthEnabled).toBe(true);
      expect(body.data.devAccounts).toEqual(PEOPLE);
    });

    it('signs in a configured account, with its name and email, and refuses tim', async () => {
      const store = new MemoryStore();
      const app = createApp(config(true), { store });
      const signIn = (account: string) =>
        app.request('/auth/dev', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account }),
        });
      expect((await signIn('priya')).status).toBe(200);
      const person = await store.person(userIdFor('dev', 'priya'));
      expect(person?.name).toBe('Priya Shah');
      expect(person?.email).toBe('priya.shah@example.com');
      expect((await signIn('tim')).status).toBe(400);
    });

    it('offers nothing, and signs nobody in, when DEV_AUTH is off', async () => {
      const app = createApp(config(false), { store: new MemoryStore() });
      const body = (await (await app.request('/api/auth/config')).json()) as {
        data: { devAccounts: unknown[] };
      };
      expect(body.data.devAccounts).toEqual([]);
      const response = await app.request('/auth/dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'priya' }),
      });
      expect(response.status).toBe(404);
    });
  });
});
