import postgres from 'postgres';
import {
  type AuditEntry,
  LAST_ADMIN_MESSAGE,
  type Person,
  type PersonalAgent,
  type PersonChange,
  type PlatformConnection,
  type Store,
  StoreError,
} from './store.ts';

/**
 * Migrations, in order. Kept in code (not .sql files) so they ship with the
 * compiled server. Never edit one that has been released: add the next.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'people, settings, preferences, audit log',
    sql: `
      create table people (
        id text primary key,
        email text not null default '',
        name text not null default '',
        role text not null default 'user' check (role in ('admin', 'user')),
        status text not null default 'active' check (status in ('active', 'suspended')),
        session_version integer not null default 1,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz
      );
      create index people_email on people (lower(email));

      create table settings (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now(),
        updated_by text references people (id) on delete set null
      );

      create table user_prefs (
        person_id text not null references people (id) on delete cascade,
        key text not null,
        value jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (person_id, key)
      );

      create table audit_log (
        id bigserial primary key,
        at timestamptz not null default now(),
        actor_id text,
        action text not null,
        target_id text,
        details jsonb not null default '{}'
      );
      create index audit_log_at on audit_log (at desc);
    `,
  },
  {
    version: 2,
    name: 'personal agents',
    sql: `
      create table personal_agents (
        person_id text not null references people (id) on delete cascade,
        slot text not null,
        name text not null,
        created_at timestamptz not null default now(),
        primary key (person_id, slot)
      );
    `,
  },
  {
    version: 3,
    name: 'platform connections and provided copies (Connect mode)',
    sql: `
      create table platform_connections (
        person_id text primary key references people (id) on delete cascade,
        access_token text not null,
        access_expires_at timestamptz not null,
        refresh_token text not null,
        platform_user_id text,
        platform_email text,
        platform_name text,
        updated_at timestamptz not null default now()
      );
      create table provided_copies (
        person_id text not null references people (id) on delete cascade,
        provided_id text not null,
        agent_id text not null,
        primary key (person_id, provided_id)
      );
    `,
  },
];

/** Any number, the same for every replica: only one migrates at a time. */
const MIGRATION_LOCK = 72_017_001;
/** The advisory-lock class for refreshing one person's platform tokens. */
const CONNECTION_LOCK = 72_017_002;

type Sql = postgres.Sql;

interface PersonRow {
  id: string;
  email: string;
  name: string;
  role: Person['role'];
  status: Person['status'];
  session_version: number;
  created_at: Date;
  last_seen_at: Date | null;
}

const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  status: row.status,
  sessionVersion: row.session_version,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

/** Applies the migrations not yet applied, holding a lock so replicas starting together do not race. */
/** Errors that mean "the database is not reachable yet" (starting up, a network not ready), not "this is misconfigured". */
const NOT_YET = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  '57P03', // the database system is starting up
  '53300', // too many connections
]);

function isNotYet(error: unknown): boolean {
  const e = error as { code?: string; errors?: unknown[] } | null;
  if (!e) return false;
  if (e.code && NOT_YET.has(e.code)) return true;
  // An address that resolves several ways reports each failure: all must be "not yet".
  return Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every(isNotYet);
}

/**
 * Waits for the database to answer, for up to `timeoutMs` (default three
 * minutes). A pod that starts beside its database (a first deploy, a restart
 * of the node) would otherwise exit and be restarted until it came up. Only
 * "not reachable yet" errors are waited out: a wrong password or a database
 * that does not exist fails at once, with the database's own message.
 */
export async function waitForDatabase(
  sql: Sql,
  options: {
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  const started = now();
  let wait = 500;
  let told = false;
  for (;;) {
    try {
      await sql`select 1`;
      if (told)
        log(`[server] the database answered after ${Math.round((now() - started) / 1000)}s`);
      return;
    } catch (error) {
      if (!isNotYet(error)) throw error;
      if (now() - started >= timeoutMs)
        throw new Error(
          `The database did not answer within ${Math.round(timeoutMs / 1000)}s: ${(error as Error).message}`,
        );
      if (!told) log('[server] waiting for the database…');
      told = true;
      await sleep(wait);
      wait = Math.min(wait * 2, 5_000);
    }
  }
}

export async function migrate(sql: Sql): Promise<number[]> {
  const applied: number[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )`;
    const done = new Set(
      (await tx<{ version: number }[]>`select version from schema_migrations`).map(
        (row) => row.version,
      ),
    );
    for (const migration of MIGRATIONS) {
      if (done.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`insert into schema_migrations (version, name) values (${migration.version}, ${migration.name})`;
      applied.push(migration.version);
    }
  });
  return applied;
}

export class PgStore implements Store {
  constructor(readonly sql: Sql) {}

  static connect(url: string): PgStore {
    return new PgStore(postgres(url, { max: 10, idle_timeout: 30, onnotice: () => undefined }));
  }

  async signIn(
    user: { id: string; email: string; name: string },
    initialAdminEmail: string | null,
    adminByGroup: boolean | null = null,
  ) {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<(PersonRow & { inserted: boolean })[]>`
        insert into people (id, email, name, last_seen_at)
        values (${user.id}, ${user.email}, ${user.name}, now())
        on conflict (id) do update set email = excluded.email, name = excluded.name, last_seen_at = now()
        returning *, (xmax = 0) as inserted`;
      if (!row) throw new Error('sign-in upsert returned nothing');
      if (row.inserted)
        await tx`insert into audit_log (action, target_id, details) values ('person.created', ${user.id}, ${tx.json({ email: user.email })})`;
      let person = toPerson(row);
      const wanted = initialAdminEmail?.trim().toLowerCase();
      if (person.role !== 'admin' && wanted && person.email.trim().toLowerCase() === wanted) {
        // Only while there is no active administrator: a later demotion sticks.
        const [admins] = await tx<{ count: number }[]>`
          select count(*)::int as count from people where role = 'admin' and status = 'active'`;
        if ((admins?.count ?? 0) === 0) {
          const [promoted] = await tx<
            PersonRow[]
          >`update people set role = 'admin' where id = ${user.id} returning *`;
          await tx`insert into audit_log (action, target_id, details) values ('person.initial_admin', ${user.id}, ${tx.json({ email: user.email })})`;
          if (promoted) person = toPerson(promoted);
        }
      }
      if (adminByGroup !== null) {
        const wanted = adminByGroup ? 'admin' : 'user';
        if (person.role !== wanted) {
          // Never demote the last active administrator: that would lock everyone out.
          const [others] = await tx<{ count: number }[]>`
            select count(*)::int as count from people
            where role = 'admin' and status = 'active' and id <> ${user.id}`;
          const lastAdmin =
            person.role === 'admin' && person.status === 'active' && (others?.count ?? 0) === 0;
          if (!(wanted === 'user' && lastAdmin)) {
            const [changed] = await tx<
              PersonRow[]
            >`update people set role = ${wanted} where id = ${user.id} returning *`;
            await tx`insert into audit_log (action, target_id, details)
              values ('person.role', ${user.id}, ${tx.json({ from: person.role, to: wanted, via: 'group' })})`;
            if (changed) person = toPerson(changed);
          }
        }
      }
      return person;
    });
  }

  async person(id: string) {
    const [row] = await this.sql<PersonRow[]>`select * from people where id = ${id}`;
    return row ? toPerson(row) : null;
  }

  async people(search?: string) {
    const q = search?.trim();
    const rows = q
      ? await this.sql<PersonRow[]>`
          select * from people where email ilike ${`%${q}%`} or name ilike ${`%${q}%`}
          order by last_seen_at desc nulls last limit 500`
      : await this.sql<
          PersonRow[]
        >`select * from people order by last_seen_at desc nulls last limit 500`;
    return rows.map(toPerson);
  }

  async updatePerson(id: string, change: PersonChange, actorId: string | null) {
    return this.sql.begin(async (tx) => {
      // Locking the active administrators serialises changes that could leave none.
      const admins = await tx<{ id: string }[]>`
        select id from people where role = 'admin' and status = 'active' for update`;
      const [before] = await tx<PersonRow[]>`select * from people where id = ${id} for update`;
      if (!before) throw new StoreError('not_found', 'No such person');
      const role = change.role ?? before.role;
      const status = change.status ?? before.status;
      const wasAdmin = before.role === 'admin' && before.status === 'active';
      if (wasAdmin && !(role === 'admin' && status === 'active') && admins.length <= 1)
        throw new StoreError('last_admin', LAST_ADMIN_MESSAGE);
      const suspending = status === 'suspended' && before.status !== 'suspended';
      const [after] = await tx<PersonRow[]>`
        update people set role = ${role}, status = ${status},
          session_version = session_version + ${suspending ? 1 : 0}
        where id = ${id} returning *`;
      if (role !== before.role)
        await tx`insert into audit_log (actor_id, action, target_id, details)
          values (${actorId}, 'person.role', ${id}, ${tx.json({ from: before.role, to: role })})`;
      if (status !== before.status)
        await tx`insert into audit_log (actor_id, action, target_id, details)
          values (${actorId}, 'person.status', ${id}, ${tx.json({ from: before.status, to: status })})`;
      return toPerson(after!);
    });
  }

  async endSessions(id: string, actorId: string | null) {
    const rows = await this
      .sql`update people set session_version = session_version + 1 where id = ${id} returning id`;
    if (rows.length === 0) throw new StoreError('not_found', 'No such person');
    await this
      .sql`insert into audit_log (actor_id, action, target_id) values (${actorId}, 'person.sessions_ended', ${id})`;
  }

  async promote(email: string) {
    const [row] = await this.sql<PersonRow[]>`
      update people set role = 'admin', status = 'active'
      where lower(email) = ${email.trim().toLowerCase()} returning *`;
    if (!row) return null;
    await this.sql`insert into audit_log (action, target_id, details)
      values ('person.promoted_cli', ${row.id}, ${this.sql.json({ email })})`;
    return toPerson(row);
  }

  async audit(limit: number): Promise<AuditEntry[]> {
    const rows = await this.sql<
      {
        id: string;
        at: Date;
        actor_id: string | null;
        action: string;
        target_id: string | null;
        details: Record<string, unknown>;
      }[]
    >`select * from audit_log order by id desc limit ${Math.max(1, Math.min(limit, 1000))}`;
    return rows.map((row) => ({
      id: Number(row.id),
      at: row.at,
      actorId: row.actor_id,
      action: row.action,
      targetId: row.target_id,
      details: row.details,
    }));
  }

  async personalAgents(personId: string): Promise<PersonalAgent[]> {
    const rows = await this.sql<{ slot: string; name: string; created_at: Date }[]>`
      select slot, name, created_at from personal_agents where person_id = ${personId} order by created_at, slot`;
    return rows.map((row) => ({ slot: row.slot, name: row.name, createdAt: row.created_at }));
  }

  async addPersonalAgent(personId: string, slot: string, name: string) {
    try {
      await this
        .sql`insert into personal_agents (person_id, slot, name) values (${personId}, ${slot}, ${name})`;
    } catch (error) {
      if ((error as { code?: string }).code === '23503')
        throw new StoreError('not_found', 'No such person');
      throw error;
    }
  }

  async renamePersonalAgent(personId: string, slot: string, name: string) {
    const rows = await this
      .sql`update personal_agents set name = ${name} where person_id = ${personId} and slot = ${slot} returning slot`;
    if (rows.length === 0) throw new StoreError('not_found', 'No such agent');
  }

  async removePersonalAgent(personId: string, slot: string) {
    await this.sql`delete from personal_agents where person_id = ${personId} and slot = ${slot}`;
  }

  async connection(personId: string): Promise<PlatformConnection | null> {
    const [row] = await this.sql<
      {
        access_token: string;
        access_expires_at: Date;
        refresh_token: string;
        platform_user_id: string | null;
        platform_email: string | null;
        platform_name: string | null;
        updated_at: Date;
      }[]
    >`select access_token, access_expires_at, refresh_token, platform_user_id, platform_email,
             platform_name, updated_at
        from platform_connections where person_id = ${personId}`;
    return row
      ? {
          accessToken: row.access_token,
          accessExpiresAt: row.access_expires_at,
          refreshToken: row.refresh_token,
          platformUserId: row.platform_user_id,
          platformEmail: row.platform_email,
          platformName: row.platform_name,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async connectionIds() {
    const rows = await this.sql<
      { person_id: string }[]
    >`select person_id from platform_connections`;
    return rows.map((row) => row.person_id);
  }

  async saveConnection(personId: string, c: PlatformConnection) {
    try {
      await this.sql`
        insert into platform_connections (person_id, access_token, access_expires_at, refresh_token,
                                          platform_user_id, platform_email, platform_name, updated_at)
        values (${personId}, ${c.accessToken}, ${c.accessExpiresAt}, ${c.refreshToken},
                ${c.platformUserId}, ${c.platformEmail}, ${c.platformName}, now())
        on conflict (person_id) do update set
          access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
          refresh_token = excluded.refresh_token, platform_user_id = excluded.platform_user_id,
          platform_email = excluded.platform_email, platform_name = excluded.platform_name,
          updated_at = now()`;
    } catch (error) {
      if ((error as { code?: string }).code === '23503')
        throw new StoreError('not_found', 'No such person');
      throw error;
    }
  }

  async removeConnection(personId: string) {
    await this.sql`delete from platform_connections where person_id = ${personId}`;
  }

  async withConnectionLock<T>(personId: string, fn: () => Promise<T>): Promise<T> {
    // A transaction-scoped advisory lock on the person: other replicas wait for it.
    let out: T;
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${CONNECTION_LOCK}, hashtext(${personId}))`;
      out = await fn();
    });
    return out!;
  }

  async providedCopies(personId: string) {
    const rows = await this.sql<{ provided_id: string; agent_id: string }[]>`
      select provided_id, agent_id from provided_copies where person_id = ${personId}`;
    return new Map(rows.map((row) => [row.provided_id, row.agent_id]));
  }

  async setProvidedCopy(personId: string, providedId: string, agentId: string) {
    await this.sql`
      insert into provided_copies (person_id, provided_id, agent_id) values (${personId}, ${providedId}, ${agentId})
      on conflict (person_id, provided_id) do update set agent_id = excluded.agent_id`;
  }

  async removeProvidedCopy(personId: string, providedId: string) {
    await this
      .sql`delete from provided_copies where person_id = ${personId} and provided_id = ${providedId}`;
  }

  async setting(key: string) {
    const [row] = await this.sql<
      { value: unknown }[]
    >`select value from settings where key = ${key}`;
    return row ? row.value : null;
  }

  async setSetting(key: string, value: unknown, actorId: string | null) {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into settings (key, value, updated_by) values (${key}, ${tx.json(value as never)}, ${actorId})
        on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
      await tx`insert into audit_log (actor_id, action) values (${actorId}, ${`settings.${key}`})`;
    });
  }

  async prefs(personId: string) {
    const rows = await this.sql<{ key: string; value: unknown }[]>`
      select key, value from user_prefs where person_id = ${personId}`;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async setPref(personId: string, key: string, value: unknown) {
    try {
      await this.sql`
        insert into user_prefs (person_id, key, value) values (${personId}, ${key}, ${this.sql.json(value as never)})
        on conflict (person_id, key) do update set value = excluded.value, updated_at = now()`;
    } catch (error) {
      if ((error as { code?: string }).code === '23503')
        throw new StoreError('not_found', 'No such person');
      throw error;
    }
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }
}
