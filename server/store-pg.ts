import postgres from 'postgres';
import {
  type AuditEntry,
  LAST_ADMIN_MESSAGE,
  type Person,
  type PersonChange,
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
];

/** Any number, the same for every replica: only one migrates at a time. */
const MIGRATION_LOCK = 72_017_001;

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

  async close() {
    await this.sql.end({ timeout: 5 });
  }
}
