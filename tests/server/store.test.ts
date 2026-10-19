// @vitest-environment node
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, type Store, StoreError } from '../../server/store.ts';
import { MIGRATIONS, migrate, PgStore } from '../../server/store-pg.ts';

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

    it('follows the provider’s groups for the role on each sign-in, auditing the change', async () => {
      expect((await store.signIn(bob, null, true)).role).toBe('admin');
      expect((await store.signIn(tim, null, true)).role).toBe('admin');
      expect((await store.signIn(tim, null, false)).role).toBe('user');
      expect((await store.signIn(tim, null, null)).role).toBe('user');
      const changes = (await store.audit(20)).filter((entry) => entry.action === 'person.role');
      expect(changes.map((entry) => entry.details)).toEqual([
        { from: 'admin', to: 'user', via: 'group' },
        { from: 'user', to: 'admin', via: 'group' },
        { from: 'user', to: 'admin', via: 'group' },
      ]);
    });

    it('does not let the provider demote the last active administrator', async () => {
      await store.signIn(tim, null, true);
      expect((await store.signIn(tim, null, false)).role).toBe('admin');
    });

    it('keeps a searchable copy of conversations, per person, found by the start of words', async () => {
      await store.signIn(tim, null);
      await store.signIn(bob, null);
      await store.indexThread(
        'tim',
        'agent-1',
        't-desk',
        'Can I expense a standing desk?\nYes, up to $400.',
      );
      await store.indexThread('tim', 'agent-1', 't-churn', 'Export the churn report to CSV');
      await store.indexThread('bob', 'agent-9', 't-bobs', 'My own standing meeting notes');

      const found = await store.searchIndex('tim', 'expen desk', 10);
      expect(found.map((hit) => `${hit.agentId}/${hit.threadId}`)).toEqual(['agent-1/t-desk']);
      expect(found[0]?.snippet.replaceAll('\u0001', '[').replaceAll('\u0002', ']')).toMatch(
        /\[expense\]/i,
      );
      expect(found[0]?.indexedAt).toBeInstanceOf(Date);

      // Every word has to be there; a word's start is enough; a word's middle is not.
      expect(await store.searchIndex('tim', 'expense churn', 10)).toEqual([]);
      expect((await store.searchIndex('tim', 'REPORT', 10)).map((h) => h.threadId)).toEqual([
        't-churn',
      ]);
      expect(await store.searchIndex('tim', 'xpense', 10)).toEqual([]);
      // Operators in a query are only words.
      expect(await store.searchIndex('tim', "desk' | 1=1 --", 10)).toEqual([]);
      expect(await store.searchIndex('tim', '   ', 10)).toEqual([]);
      // Each person's own: Bob's matches do not reach Tim, nor Tim's Bob.
      expect((await store.searchIndex('tim', 'standing', 10)).map((h) => h.threadId)).toEqual([
        't-desk',
      ]);
      expect((await store.searchIndex('bob', 'standing', 10)).map((h) => h.threadId)).toEqual([
        't-bobs',
      ]);
      expect(await store.searchIndex('bob', 'churn', 10)).toEqual([]);
    });

    it('replaces a conversation\u2019s copy as it grows, drops it when emptied or forgotten, and limits results', async () => {
      await store.signIn(tim, null);
      await store.indexThread('tim', 'a', 't1', 'first version about apples');
      await store.indexThread('tim', 'a', 't1', 'second version about pears');
      expect(await store.searchIndex('tim', 'apples', 10)).toEqual([]);
      expect((await store.searchIndex('tim', 'pears', 10)).length).toBe(1);
      await store.indexThread('tim', 'a', 't1', '   ');
      expect(await store.searchIndex('tim', 'pears', 10)).toEqual([]);

      for (let i = 0; i < 5; i++)
        await store.indexThread('tim', 'a', `t${i}`, `note ${i} about plums`);
      expect(await store.searchIndex('tim', 'plums', 3)).toHaveLength(3);
      await store.forgetIndexed('tim', 'a', 't2');
      expect((await store.searchIndex('tim', 'plums', 10)).map((h) => h.threadId).sort()).toEqual([
        't0',
        't1',
        't3',
        't4',
      ]);
      await store.forgetIndexed('tim', 'a', 'never-indexed'); // not an error
    });

    it('purges every copy, for everyone, and records it', async () => {
      await store.signIn(tim, null);
      await store.signIn(bob, null);
      await store.indexThread('tim', 'a', 't1', 'plums');
      await store.indexThread('bob', 'a', 't2', 'plums');
      expect(await store.purgeIndex('tim')).toBe(2);
      expect(await store.searchIndex('tim', 'plums', 10)).toEqual([]);
      expect(await store.searchIndex('bob', 'plums', 10)).toEqual([]);
      const entry = (await store.audit(5)).find((e) => e.action === 'search.index_purged');
      expect(entry?.details).toEqual({ conversations: 2 });
      expect(entry?.actorId).toBe('tim');
    });

    it('refuses to index for someone who has not signed in', async () => {
      await expect(store.indexThread('nobody', 'a', 't', 'text')).rejects.toMatchObject({
        code: 'not_found',
      });
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

    it('saves preferences per person, replacing a key as a whole', async () => {
      await store.signIn(tim, null);
      await store.signIn(bob, null);
      await store.setPref('tim', 'appearance', { theme: 'light', codeWrap: true });
      await store.setPref('tim', 'appearance', { theme: 'dark' });
      await store.setPref('tim', 'inbox', { threads: { 'a/1': { pinnedAt: 5 } } });
      expect(await store.prefs('tim')).toEqual({
        appearance: { theme: 'dark' },
        inbox: { threads: { 'a/1': { pinnedAt: 5 } } },
      });
      expect(await store.prefs('bob')).toEqual({});
      await expect(store.setPref('nobody', 'appearance', {})).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('saves settings, and records who changed them', async () => {
      await store.signIn(tim, 'tim@example.test');
      expect(await store.setting('branding')).toBeNull();
      await store.setSetting('branding', { name: 'Acme' }, 'tim');
      await store.setSetting('branding', { name: 'Acme Agents' }, 'tim');
      expect(await store.setting('branding')).toEqual({ name: 'Acme Agents' });
      expect((await store.audit(1))[0]).toMatchObject({
        actorId: 'tim',
        action: 'settings.branding',
      });
    });

    it('keeps each person’s own agents, oldest first', async () => {
      await store.signIn(tim, null);
      await store.signIn(bob, null);
      await store.addPersonalAgent('tim', 'a1', 'Coder');
      await store.addPersonalAgent('tim', 'b2', 'Researcher');
      await store.renamePersonalAgent('tim', 'a1', 'Code helper');
      expect((await store.personalAgents('tim')).map((agent) => [agent.slot, agent.name])).toEqual([
        ['a1', 'Code helper'],
        ['b2', 'Researcher'],
      ]);
      expect(await store.personalAgents('bob')).toEqual([]);
      await store.removePersonalAgent('tim', 'a1');
      expect((await store.personalAgents('tim')).map((agent) => agent.slot)).toEqual(['b2']);
      await expect(store.renamePersonalAgent('bob', 'b2', 'x')).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('keeps a person’s platform connection, replaces it, and forgets it (and with the person)', async () => {
      await store.signIn(tim, null);
      expect(await store.connection('tim')).toBeNull();
      const connection = {
        accessToken: 'enc-a',
        accessExpiresAt: new Date('2026-10-18T12:00:00Z'),
        refreshToken: 'enc-r',
        platformUserId: 'u1',
        platformEmail: 'tim@example.test',
        platformName: 'Tim',
        updatedAt: new Date(),
      };
      await store.saveConnection('tim', connection);
      expect(await store.connection('tim')).toMatchObject({
        accessToken: 'enc-a',
        refreshToken: 'enc-r',
        platformEmail: 'tim@example.test',
      });
      await store.saveConnection('tim', { ...connection, accessToken: 'enc-a2' });
      expect((await store.connection('tim'))?.accessToken).toBe('enc-a2');
      await expect(store.saveConnection('nobody', connection)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect(await store.connectionIds()).toEqual(['tim']);
      await store.removeConnection('tim');
      expect(await store.connection('tim')).toBeNull();
      expect(await store.connectionIds()).toEqual([]);
    });

    it('runs one refresh at a time per person', async () => {
      await store.signIn(tim, null);
      const order: string[] = [];
      const slow = (label: string, ms: number) => () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            order.push(label);
            resolve(label);
          }, ms),
        );
      const results = await Promise.all([
        store.withConnectionLock('tim', async () => {
          order.push('first:start');
          return slow('first:end', 40)();
        }),
        store.withConnectionLock('tim', async () => {
          order.push('second:start');
          return slow('second:end', 1)();
        }),
      ]);
      expect(results).toEqual(['first:end', 'second:end']);
      expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('remembers which agent is each person’s copy of a provided agent', async () => {
      await store.signIn(tim, null);
      await store.setProvidedCopy('tim', 'assistant', 'agent-1');
      await store.setProvidedCopy('tim', 'hr', 'agent-2');
      await store.setProvidedCopy('tim', 'hr', 'agent-3');
      expect([...(await store.providedCopies('tim'))].sort()).toEqual([
        ['assistant', 'agent-1'],
        ['hr', 'agent-3'],
      ]);
      await store.removeProvidedCopy('tim', 'hr');
      expect([...(await store.providedCopies('tim'))]).toEqual([['assistant', 'agent-1']]);
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
    expect(await migrate(store.sql)).toEqual([1, 2, 3, 4]);
    expect(await migrate(store.sql)).toEqual([]);
  });

  it('upgrades a database a release behind, keeping what it holds', async () => {
    // A database as 0.4.0 left it: migrations 1 to 3, with a person and a connection in it.
    const db = `${name}_upgrade`;
    await admin.unsafe(`create database ${db}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${db}`;
    const store = PgStore.connect(url.href);
    stores.push(store);
    await store.sql`create table schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())`;
    for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) {
      await store.sql.unsafe(migration.sql);
      await store.sql`insert into schema_migrations (version, name) values (${migration.version}, ${migration.name})`;
    }
    await store.sql`insert into people (id, email, name) values ('old', 'old@example.test', 'Old')`;
    expect(await migrate(store.sql)).toEqual([4]);
    expect(await store.person('old')).toMatchObject({ email: 'old@example.test' });
    await store.indexThread('old', 'a', 't', 'now searchable');
    expect(await store.searchIndex('old', 'searchable', 5)).toHaveLength(1);
    // And an older release started against this database still finds what it knows.
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
