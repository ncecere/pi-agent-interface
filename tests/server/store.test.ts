// @vitest-environment node
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, type Store, StoreError } from '../../server/store.ts';
import { migrate, PgStore } from '../../server/store-pg.ts';

/**
 * One contract, two stores. The Postgres run needs a server: the development
 * one (`pnpm db:up`), or TEST_DATABASE_URL. It creates a database of its own and
 * drops it after; without a server it is skipped, unless PAI_TEST_REQUIRE_DB=1.
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://pai:pai-local-only@127.0.0.1:55433/pai';

async function postgresAvailable(): Promise<boolean> {
  const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2, onnotice: () => undefined });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const tim = { id: 'tim', email: 'Tim@Example.test', name: 'Tim' };
const bob = { id: 'bob', email: 'bob@example.test', name: 'Bob' };
const sally = { id: 'sally', email: 'sally@example.test', name: 'Sally' };

function contract(name: string, make: () => Promise<Store>) {
  describe(name, () => {
    let store: Store;
    beforeEach(async () => {
      store = await make();
    });

    it('creates a person on first sign-in and updates them on the next', async () => {
      const first = await store.signIn(tim, null);
      expect(first).toMatchObject({ id: 'tim', role: 'user', status: 'active', sessionVersion: 1 });
      const again = await store.signIn({ ...tim, name: 'Timothy' }, null);
      expect(again.name).toBe('Timothy');
      expect(again.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect((await store.people()).length).toBe(1);
    });

    it('makes the initial admin an administrator, matching the email in any case', async () => {
      expect((await store.signIn(bob, 'tim@example.test')).role).toBe('user');
      expect((await store.signIn(tim, 'tim@example.test')).role).toBe('admin');
    });

    it('does not make the initial admin an administrator again once there is one', async () => {
      await store.signIn(tim, 'tim@example.test');
      await store.signIn(bob, null);
      await store.updatePerson('bob', { role: 'admin' }, 'tim');
      await store.updatePerson('tim', { role: 'user' }, 'bob');
      // A demotion sticks: Tim signing in again stays a user.
      expect((await store.signIn(tim, 'tim@example.test')).role).toBe('user');
    });

    it('never leaves no active administrator', async () => {
      await store.signIn(tim, 'tim@example.test');
      await expect(store.updatePerson('tim', { role: 'user' }, 'tim')).rejects.toMatchObject({
        code: 'last_admin',
      });
      await expect(
        store.updatePerson('tim', { status: 'suspended' }, 'tim'),
      ).rejects.toBeInstanceOf(StoreError);
      await store.signIn(bob, null);
      await store.updatePerson('bob', { role: 'admin' }, 'tim');
      expect((await store.updatePerson('tim', { role: 'user' }, 'bob')).role).toBe('user');
    });

    it('ends a person’s sessions when they are suspended, or asked to', async () => {
      await store.signIn(tim, 'tim@example.test');
      await store.signIn(bob, null);
      const suspended = await store.updatePerson('bob', { status: 'suspended' }, 'tim');
      expect(suspended.sessionVersion).toBe(2);
      await store.endSessions('tim', 'tim');
      expect((await store.person('tim'))?.sessionVersion).toBe(2);
    });

    it('reports a person that does not exist', async () => {
      await expect(store.updatePerson('nobody', { role: 'admin' }, null)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(await store.person('nobody')).toBeNull();
    });

    it('searches by name or email', async () => {
      for (const person of [tim, bob, sally]) await store.signIn(person, null);
      expect((await store.people('sal')).map((person) => person.id)).toEqual(['sally']);
      expect((await store.people('EXAMPLE')).length).toBe(3);
    });

    it('promotes from the recovery command, and restores a suspended person', async () => {
      await store.signIn(tim, 'tim@example.test');
      await store.signIn(bob, null);
      await store.updatePerson('bob', { status: 'suspended' }, 'tim');
      const promoted = await store.promote('BOB@example.test');
      expect(promoted).toMatchObject({ role: 'admin', status: 'active' });
      expect(await store.promote('nobody@example.test')).toBeNull();
    });

    it('keeps an audit log of who changed what, newest first', async () => {
      await store.signIn(tim, 'tim@example.test');
      await store.signIn(bob, null);
      await store.updatePerson('bob', { role: 'admin' }, 'tim');
      const [latest] = await store.audit(10);
      expect(latest).toMatchObject({
        actorId: 'tim',
        action: 'person.role',
        targetId: 'bob',
        details: { from: 'user', to: 'admin' },
      });
      expect((await store.audit(100)).map((entry) => entry.action)).toContain(
        'person.initial_admin',
      );
    });
  });
}

contract('MemoryStore', async () => new MemoryStore());

const available = await postgresAvailable();
if (!available && process.env.PAI_TEST_REQUIRE_DB === '1')
  throw new Error(`No Postgres at ${ADMIN_URL}`);

describe.skipIf(!available)('PgStore', () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  const name = `pai_test_${process.pid}_${Date.now()}`;
  let stores: PgStore[] = [];
  let n = 0;

  beforeAll(async () => {
    await admin.unsafe(`create database ${name}`);
  });
  afterAll(async () => {
    for (const store of stores) await store.close();
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  });

  it('migrates once, and again is a no-op', async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    const store = PgStore.connect(url.href);
    stores.push(store);
    expect(await migrate(store.sql)).toEqual([1]);
    expect(await migrate(store.sql)).toEqual([]);
  });

  // Each test gets a clean schema in a database of its own.
  contract('contract', async () => {
    const db = `${name}_${n++}`;
    await admin.unsafe(`create database ${db}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${db}`;
    const store = PgStore.connect(url.href);
    stores.push(store);
    await migrate(store.sql);
    const close = store.close.bind(store);
    store.close = async () => {
      await close();
      await admin.unsafe(`drop database if exists ${db} with (force)`);
    };
    return store;
  });

  afterAll(async () => {
    const left = stores;
    stores = [];
    for (const store of left) await store.close().catch(() => undefined);
  });
});
