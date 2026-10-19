/**
 * The chat app's own records: the people who have signed in, their role, and
 * (later) settings and preferences. Conversations are not here; they live on
 * the platform. `PgStore` (store-pg.ts) is the real one; `MemoryStore` keeps
 * tests that are not about storage fast, and runs the same contract tests.
 */

import { matchesTerms, type SearchHit, searchTerms, snippetOf } from './search.ts';

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
   *
   * `adminByGroup` is the identity provider's say on the role (OIDC_ADMIN_GROUPS):
   * true makes the person an administrator, false a member (never the last
   * active administrator), null leaves the role alone.
   */
  signIn(
    user: { id: string; email: string; name: string },
    initialAdminEmail: string | null,
    adminByGroup?: boolean | null,
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
  /**
   * The searchable copy of a conversation's text (the `messageSearch` feature), replaced as the conversation
   * grows. One per person and conversation; an empty body removes it.
   */
  indexThread(personId: string, agentId: string, threadId: string, body: string): Promise<void>;
  /** Conversations of this person whose text holds every word of the query (each word as a start of a word). */
  searchIndex(personId: string, query: string, limit: number): Promise<SearchHit[]>;
  /** The copy of a conversation that was deleted. */
  forgetIndexed(personId: string, agentId: string, threadId: string): Promise<void>;
  /** Everything indexed, for everyone (the feature was turned off). How many conversations; recorded in the audit log. */
  purgeIndex(actorId: string | null): Promise<number>;
  /** A person's connection to the platform (Connect mode); tokens are stored as given (encrypted by the caller). */
  connection(personId: string): Promise<PlatformConnection | null>;
  /** Everyone who has a connection (for re-sealing tokens after a secret rotation). */
  connectionIds(): Promise<string[]>;
  saveConnection(personId: string, connection: PlatformConnection): Promise<void>;
  removeConnection(personId: string): Promise<void>;
  /**
   * Runs `fn` while holding this person's connection lock, so two replicas (or
   * two requests) never refresh the same tokens at once.
   */
  withConnectionLock<T>(personId: string, fn: () => Promise<T>): Promise<T>;
  /** Which agent is a person's copy of each provided agent (Connect mode: in their personal workspace). */
  providedCopies(personId: string): Promise<Map<string, string>>;
  setProvidedCopy(personId: string, providedId: string, agentId: string): Promise<void>;
  removeProvidedCopy(personId: string, providedId: string): Promise<void>;
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
/** A person's tokens for the platform (Connect mode). The token fields hold ciphertext. */
export interface PlatformConnection {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  /** Who they are on the platform (GET /v1/me), for Settings and the email check. */
  platformUserId: string | null;
  platformEmail: string | null;
  platformName: string | null;
  updatedAt: Date;
}

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
    adminByGroup: boolean | null = null,
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
    if (adminByGroup !== null) {
      const wanted: Role = adminByGroup ? 'admin' : 'user';
      const lastAdmin =
        person.role === 'admin' &&
        person.status === 'active' &&
        this.activeAdmins().filter((other) => other.id !== user.id).length === 0;
      if (person.role !== wanted && !(wanted === 'user' && lastAdmin)) {
        this.record(null, 'person.role', user.id, { from: person.role, to: wanted, via: 'group' });
        person.role = wanted;
      }
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

  private readonly indexed = new Map<string, { at: Date; body: string }>();

  async indexThread(personId: string, agentId: string, threadId: string, body: string) {
    if (!this.rows.has(personId)) throw new StoreError('not_found', 'No such person');
    const key = `${personId}\u0000${agentId}\u0000${threadId}`;
    if (body.trim()) this.indexed.set(key, { at: new Date(), body });
    else this.indexed.delete(key);
  }

  async searchIndex(personId: string, query: string, limit: number) {
    const terms = searchTerms(query);
    const hits: SearchHit[] = [];
    for (const [key, row] of this.indexed) {
      const [owner, agentId, threadId] = key.split('\u0000');
      if (owner !== personId || !agentId || !threadId || !matchesTerms(row.body, terms)) continue;
      hits.push({ agentId, threadId, snippet: snippetOf(row.body, terms), indexedAt: row.at });
    }
    return hits.sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime()).slice(0, limit);
  }

  async forgetIndexed(personId: string, agentId: string, threadId: string) {
    this.indexed.delete(`${personId}\u0000${agentId}\u0000${threadId}`);
  }

  async purgeIndex(actorId: string | null) {
    const count = this.indexed.size;
    this.indexed.clear();
    this.record(actorId, 'search.index_purged', null, { conversations: count });
    return count;
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

  private readonly connections = new Map<string, PlatformConnection>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly copies = new Map<string, Map<string, string>>();

  async connection(personId: string) {
    const found = this.connections.get(personId);
    return found ? structuredClone(found) : null;
  }

  async connectionIds() {
    return [...this.connections.keys()];
  }

  async saveConnection(personId: string, connection: PlatformConnection) {
    if (!this.rows.has(personId)) throw new StoreError('not_found', 'No such person');
    this.connections.set(personId, structuredClone(connection));
  }

  async removeConnection(personId: string) {
    this.connections.delete(personId);
  }

  async withConnectionLock<T>(personId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(personId) ?? Promise.resolve();
    const run = before.then(fn, fn);
    this.locks.set(
      personId,
      run.catch(() => undefined),
    );
    return run;
  }

  async providedCopies(personId: string) {
    return new Map(this.copies.get(personId) ?? []);
  }

  async setProvidedCopy(personId: string, providedId: string, agentId: string) {
    const mine = this.copies.get(personId) ?? new Map<string, string>();
    mine.set(providedId, agentId);
    this.copies.set(personId, mine);
  }

  async removeProvidedCopy(personId: string, providedId: string) {
    this.copies.get(personId)?.delete(providedId);
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
