import type { AgentThread } from '~/api/client';
import { isBlank, type ThreadMeta } from './inbox';

/**
 * Where the inbox keeps what it knows, per person, in this browser. Keyed by
 * the person's id so people sharing a browser never see each other's titles or
 * state, and cleared on sign-out.
 */
const INBOX = 'pai.inbox.';
const THREADS = 'pai.threads.';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked: everything lasts for this page only
  }
}

const clean = (meta: ThreadMeta): ThreadMeta =>
  Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));

const withoutStamp = (meta: ThreadMeta | undefined): ThreadMeta => {
  if (!meta) return {};
  const { _at: _stamp, ...rest } = meta;
  return rest;
};
const same = (a: ThreadMeta | undefined, b: ThreadMeta | undefined) =>
  JSON.stringify(withoutStamp(a)) === JSON.stringify(withoutStamp(b));

/** How long a removal is remembered, so other devices learn of it before it is forgotten. */
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

export class InboxStore {
  private snapshot: Record<string, ThreadMeta>;
  private readonly listeners = new Set<() => void>();
  private readonly name: string;

  constructor(
    readonly userId: string,
    private readonly backing: Storage | null = storage(),
  ) {
    this.name = `${INBOX}${userId}`;
    this.snapshot = this.load();
  }

  private load(): Record<string, ThreadMeta> {
    try {
      const parsed = JSON.parse(this.backing?.getItem(this.name) ?? 'null') as {
        v?: number;
        threads?: Record<string, ThreadMeta>;
      } | null;
      if (parsed?.v === 1 && parsed.threads && typeof parsed.threads === 'object')
        return parsed.threads;
    } catch {
      // Unreadable: start again.
    }
    return {};
  }

  private commit(next: Record<string, ThreadMeta>) {
    this.snapshot = next;
    try {
      this.backing?.setItem(this.name, JSON.stringify({ v: 1, threads: next }));
    } catch {
      // Storage full or blocked: the state lasts for this page only.
    }
    for (const listener of this.listeners) listener();
  }

  /** The metas by thread key. A new object on every change, so it can be a React snapshot. */
  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    // Open tabs follow each other.
    const follow = (event: StorageEvent) => {
      if (event.key !== null && event.key !== this.name) return;
      this.snapshot = this.load();
      for (const each of this.listeners) each();
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', follow);
    return () => {
      this.listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('storage', follow);
    };
  };

  get(key: string): ThreadMeta | undefined {
    return this.snapshot[key];
  }

  /**
   * Sets one conversation's meta, stamped with the time. Nothing (or a blank
   * one) leaves a stamped empty entry, so the removal reaches other devices.
   * Does nothing if it is unchanged.
   */
  set(key: string, meta: ThreadMeta | undefined) {
    const next = meta ? clean(meta) : {};
    const keep = isBlank(next) ? {} : withoutStamp(next);
    const before = this.snapshot[key];
    if ((before && same(before, keep)) || (!before && isBlank(keep))) return;
    this.commit({ ...this.snapshot, [key]: { ...keep, _at: Date.now() } });
  }

  /**
   * Takes in another device's state: for each conversation, the later change
   * wins. Returns whether this browser holds anything newer than what came in
   * (then it should be sent back).
   */
  merge(remote: Record<string, ThreadMeta>): boolean {
    let changed = false;
    let localNewer = false;
    const all = { ...this.snapshot };
    for (const key of new Set([...Object.keys(all), ...Object.keys(remote)])) {
      const mine = all[key];
      const theirs = remote[key];
      if (theirs && (!mine || (theirs._at ?? 0) > (mine._at ?? 0))) {
        all[key] = clean(theirs);
        changed = true;
      } else if (mine && (!theirs || (mine._at ?? 0) > (theirs._at ?? 0))) localNewer = true;
    }
    if (changed) this.commit(all);
    return localNewer;
  }

  /** Everything to save to the account, without removals old enough to have reached every device. */
  exportAll(now = Date.now()): Record<string, ThreadMeta> {
    return Object.fromEntries(
      Object.entries(this.snapshot).filter(
        ([, meta]) => !isBlank(meta) || now - (meta._at ?? 0) < TOMBSTONE_MS,
      ),
    );
  }

  /** Applies a change; returns what it was before, for Undo. */
  update(key: string, fn: (meta: ThreadMeta) => ThreadMeta): ThreadMeta | undefined {
    const before = this.snapshot[key];
    this.set(key, fn(before ?? {}));
    return before;
  }

  /**
   * Forgets conversations of an agent that its list no longer has, unless
   * something happened to them recently (a new one may not be listed yet).
   */
  prune(agentId: string, listed: ReadonlySet<string>, now: number, graceMs: number) {
    const prefix = `${agentId}/`;
    let all: Record<string, ThreadMeta> | null = null;
    for (const [key, meta] of Object.entries(this.snapshot)) {
      if (!key.startsWith(prefix) || listed.has(key.slice(prefix.length))) continue;
      // Activity, not when this browser last touched it (`_at`).
      const latest = Math.max(
        0,
        ...Object.entries(meta)
          .filter(([field, value]) => field !== '_at' && typeof value === 'number')
          .map(([, value]) => value as number),
      );
      if (now - latest <= graceMs) continue;
      all ??= { ...this.snapshot };
      delete all[key];
    }
    if (all) this.commit(all);
  }

  clear() {
    this.backing?.removeItem(this.name);
    this.snapshot = {};
    for (const listener of this.listeners) listener();
  }
}

const stores = new Map<string, InboxStore>();
export function inboxStoreFor(userId: string): InboxStore {
  let store = stores.get(userId);
  if (!store) {
    store = new InboxStore(userId);
    stores.set(userId, store);
  }
  return store;
}

// ── The last conversation lists, so the sidebar draws at once and a sleeping agent need not be woken ─────

export function readThreadCache(userId: string, agentId: string): AgentThread[] | undefined {
  try {
    const parsed = JSON.parse(
      storage()?.getItem(`${THREADS}${userId}.${agentId}`) ?? 'null',
    ) as unknown;
    return Array.isArray(parsed) ? (parsed as AgentThread[]) : undefined;
  } catch {
    return undefined;
  }
}

export function writeThreadCache(userId: string, agentId: string, threads: AgentThread[]) {
  try {
    storage()?.setItem(`${THREADS}${userId}.${agentId}`, JSON.stringify(threads));
  } catch {
    // Storage full or blocked: the list is simply fetched again next time.
  }
}

/** Sign-out: nothing of this person stays in the browser. */
export function clearUserData(userId: string) {
  inboxStoreFor(userId).clear();
  stores.delete(userId);
  const store = storage();
  if (store) {
    for (const key of Object.keys(store))
      if (key.startsWith(`${THREADS}${userId}.`)) store.removeItem(key);
    store.removeItem('pai.lastAgent');
  }
  try {
    sessionStorage.removeItem('pai.handover');
  } catch {
    // Nothing to clear.
  }
}
