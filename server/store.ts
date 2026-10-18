/**
 * The chat app's own records: the people who have signed in, their role, and
 * (later) settings and preferences. Conversations are not here; they live on
 * the platform. `PgStore` (store-pg.ts) is the real one; `MemoryStore` keeps
 * tests that are not about storage fast, and runs the same contract tests.
 */

export type Role = 'admin' | 'user';
export type Status = 'active' | 'suspended';

export interface Person {
  /** userIdFor(issuer, subject): stable across sign-ins. */
  id: string;
  email: string;
  name: string;
  role: Role;
  status: Status;
  /** Part of every session; raising it ends them all ("sign out everywhere", suspension). */
  sessionVersion: number;
  createdAt: Date;
  lastSeenAt: Date | null;
}

export interface AuditEntry {
  id: number;
  at: Date;
  /** Null for the system (the initial administrator, the recovery command). */
  actorId: string | null;
  action: string;
  targetId: string | null;
  details: Record<string, unknown>;
}

/** An agent a person made themselves; on the platform it is the agent with key `u:<person>:p:<slot>`. */
export interface PersonalAgent {
  slot: string;
  /** What the person calls it. */
  name: string;
  createdAt: Date;
}

export interface PersonChange {
  role?: Role;
  status?: Status;
}

export class StoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'last_admin',
    message: string,
  ) {
    super(message);
  }
}

export const LAST_ADMIN_MESSAGE = 'There must always be at least one active administrator.';

export interface Store {
  /**
   * Records a sign-in: creates the person the first time, updates their name
   * and email, and notes when they were last seen. The person whose email is
   * `initialAdminEmail` becomes an administrator, but only while there is no
   * active administrator at all (the bootstrap; a demotion later sticks).
   */
  signIn(
    user: { id: string; email: string; name: string },
    initialAdminEmail: string | null,
  ): Promise<Person>;
  person(id: string): Promise<Person | null>;
  /** Most recently seen first. */
  people(search?: string): Promise<Person[]>;
  /** Refuses to leave no active administrator. A suspension ends the person's sessions. */
  updatePerson(id: string, change: PersonChange, actorId: string | null): Promise<Person>;
  /** Ends all of a person's sessions. */
  endSessions(id: string, actorId: string | null): Promise<void>;
  /** Lockout recovery: makes the person with this email an active administrator. */
  promote(email: string): Promise<Person | null>;
  audit(limit: number): Promise<AuditEntry[]>;
  /** An instance-wide setting (branding…), or null when never saved. */
  setting(key: string): Promise<unknown>;
  /** Saves a setting, recording who changed it in the audit log. */
  setSetting(key: string, value: unknown, actorId: string | null): Promise<void>;
  /** A person's saved preferences, by key (appearance, inbox…). */
  prefs(personId: string): Promise<Record<string, unknown>>;
  setPref(personId: string, key: string, value: unknown): Promise<void>;
  /** A person's own agents, oldest first. */
  personalAgents(personId: string): Promise<PersonalAgent[]>;
  addPersonalAgent(personId: string, slot: string, name: string): Promise<void>;
  renamePersonalAgent(personId: string, slot: string, name: string): Promise<void>;
  removePersonalAgent(personId: string, slot: string): Promise<void>;
  close(): Promise<void>;
}

/** The preferences a person may save, and how large each may be (bytes of JSON). */
export const PREF_LIMITS: Record<string, number> = {
  appearance: 4 * 1024,
  inbox: 512 * 1024,
};

const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** For tests: the Store contract, in memory. */
export class MemoryStore implements Store {
  private readonly rows = new Map<string, Person>();
  private readonly log: AuditEntry[] = [];

  private record(
    actorId: string | null,
    action: string,
    targetId: string | null,
    details: Record<string, unknown> = {},
  ) {
    this.log.push({ id: this.log.length + 1, at: new Date(), actorId, action, targetId, details });
  }

  private activeAdmins() {
    return [...this.rows.values()].filter(
      (person) => person.role === 'admin' && person.status === 'active',
    );
  }

  async signIn(
    user: { id: string; email: string; name: string },
    initialAdminEmail: string | null,
  ) {
    const now = new Date();
    const existing = this.rows.get(user.id);
    const person: Person = existing
      ? { ...existing, email: user.email, name: user.name, lastSeenAt: now }
      : {
          ...user,
          role: 'user',
          status: 'active',
          sessionVersion: 1,
          createdAt: now,
          lastSeenAt: now,
        };
    if (!existing) this.record(null, 'person.created', user.id, { email: user.email });
    if (
      person.role !== 'admin' &&
      sameEmail(person.email, initialAdminEmail) &&
      this.activeAdmins().length === 0
    ) {
      person.role = 'admin';
      this.record(null, 'person.initial_admin', user.id, { email: user.email });
    }
    this.rows.set(user.id, person);
    return { ...person };
  }

  async person(id: string) {
    const person = this.rows.get(id);
    return person ? { ...person } : null;
  }

  async people(search?: string) {
    const q = search?.trim().toLowerCase();
    return [...this.rows.values()]
      .filter(
        (person) =>
          !q || person.email.toLowerCase().includes(q) || person.name.toLowerCase().includes(q),
      )
      .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
      .map((person) => ({ ...person }));
  }

  async updatePerson(id: string, change: PersonChange, actorId: string | null) {
    const person = this.rows.get(id);
    if (!person) throw new StoreError('not_found', 'No such person');
    const next = { ...person, ...change };
    const wasAdmin = person.role === 'admin' && person.status === 'active';
    const stillAdmin = next.role === 'admin' && next.status === 'active';
    if (wasAdmin && !stillAdmin && this.activeAdmins().length <= 1)
      throw new StoreError('last_admin', LAST_ADMIN_MESSAGE);
    if (change.status === 'suspended' && person.status !== 'suspended') next.sessionVersion++;
    this.rows.set(id, next);
    if (change.role && change.role !== person.role)
      this.record(actorId, 'person.role', id, { from: person.role, to: change.role });
    if (change.status && change.status !== person.status)
      this.record(actorId, 'person.status', id, { from: person.status, to: change.status });
    return { ...next };
  }

  async endSessions(id: string, actorId: string | null) {
    const person = this.rows.get(id);
    if (!person) throw new StoreError('not_found', 'No such person');
    person.sessionVersion++;
    this.record(actorId, 'person.sessions_ended', id);
  }

  async promote(email: string) {
    const person = [...this.rows.values()].find((candidate) => sameEmail(candidate.email, email));
    if (!person) return null;
    person.role = 'admin';
    person.status = 'active';
    this.record(null, 'person.promoted_cli', person.id, { email });
    return { ...person };
  }

  async audit(limit: number) {
    return [...this.log].reverse().slice(0, limit);
  }

  private readonly personal = new Map<string, PersonalAgent[]>();

  async personalAgents(personId: string) {
    return (this.personal.get(personId) ?? []).map((agent) => ({ ...agent }));
  }

  async addPersonalAgent(personId: string, slot: string, name: string) {
    if (!this.rows.has(personId)) throw new StoreError('not_found', 'No such person');
    this.personal.set(personId, [
      ...(this.personal.get(personId) ?? []),
      { slot, name, createdAt: new Date() },
    ]);
  }

  async renamePersonalAgent(personId: string, slot: string, name: string) {
    const agent = this.personal.get(personId)?.find((candidate) => candidate.slot === slot);
    if (!agent) throw new StoreError('not_found', 'No such agent');
    agent.name = name;
  }

  async removePersonalAgent(personId: string, slot: string) {
    this.personal.set(
      personId,
      (this.personal.get(personId) ?? []).filter((agent) => agent.slot !== slot),
    );
  }

  private readonly settingsMap = new Map<string, unknown>();

  async setting(key: string) {
    return this.settingsMap.has(key) ? structuredClone(this.settingsMap.get(key)) : null;
  }

  async setSetting(key: string, value: unknown, actorId: string | null) {
    this.settingsMap.set(key, structuredClone(value));
    this.record(actorId, `settings.${key}`, null);
  }

  private readonly saved = new Map<string, Record<string, unknown>>();

  async prefs(personId: string) {
    return structuredClone(this.saved.get(personId) ?? {});
  }

  async setPref(personId: string, key: string, value: unknown) {
    if (!this.rows.has(personId)) throw new StoreError('not_found', 'No such person');
    this.saved.set(personId, {
      ...(this.saved.get(personId) ?? {}),
      [key]: structuredClone(value),
    });
  }

  async close() {}
}
