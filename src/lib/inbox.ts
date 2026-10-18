/**
 * The inbox: how conversations are sorted for a person, and what each one
 * needs from them. Modelled on t3code's thread sidebar (working, snoozed,
 * settled, pinned, archived), kept in this browser: the platform only knows a
 * conversation's title and when a message was last sent, never whether a
 * reply finished or whether anyone has seen it.
 *
 * Everything here is pure (the clock is a parameter), so the rules can be
 * tested; the store and the screens are in hooks/use-inbox.ts and
 * components/layout/sidebar-inbox.tsx.
 */

/** What this browser knows about one conversation. All times are Unix milliseconds. */
export interface ThreadMeta {
  pinnedAt?: number;
  /** Hidden until this time, unless the agent finishes or fails in the meantime. */
  snoozedUntil?: number;
  snoozedAt?: number;
  /** Marked done. Anything newer than this (a message, a finished reply) brings it back. */
  settledAt?: number;
  /** Put away: out of the way until restored, whatever happens. */
  archivedAt?: number;
  /** The last time the person had it open and in view. */
  visitedAt?: number;
  /** The last time a reply was seen to finish. */
  completedAt?: number;
  /** The last time a reply was seen to fail. */
  failedAt?: number;
  /** Set while a reply is being written; cleared when it is seen to end. */
  workingSince?: number;
}

export type Bucket = 'pinned' | 'working' | 'inbox' | 'snoozed' | 'done' | 'archived';

/** What a row says it needs, most pressing first. */
export type RowStatus = 'working' | 'failed' | 'unread' | 'woke' | null;

/** How long a conversation may be believed to be working with no word from it. */
export const STALE_WORKING_MS = 2 * 60 * 60 * 1000;

/** The thread as the platform lists it (see AgentThread). */
export interface ThreadFacts {
  /** When a message was last sent. */
  updatedAt: number;
}

/** When anything last happened that the person did not do themselves. */
export function activityAt(meta: ThreadMeta, thread: ThreadFacts): number {
  return Math.max(thread.updatedAt, meta.completedAt ?? 0, meta.failedAt ?? 0);
}

export function isWorking(meta: ThreadMeta, now: number): boolean {
  return meta.workingSince !== undefined && now - meta.workingSince < STALE_WORKING_MS;
}

/**
 * Whether the snooze is still on. It ends at its time, or early when the agent
 * finishes or fails: a snooze hides a conversation, not what it has to say.
 */
export function isSnoozed(meta: ThreadMeta, now: number): boolean {
  const until = meta.snoozedUntil;
  if (until === undefined || until <= now) return false;
  const since = meta.snoozedAt ?? 0;
  return !((meta.completedAt ?? 0) > since || (meta.failedAt ?? 0) > since);
}

/** A snooze that has ended and not been looked at yet. */
export function hasWoken(meta: ThreadMeta, now: number): boolean {
  return (
    meta.snoozedUntil !== undefined &&
    !isSnoozed(meta, now) &&
    (meta.visitedAt ?? 0) < meta.snoozedUntil
  );
}

export function isSettled(meta: ThreadMeta, thread: ThreadFacts, now: number): boolean {
  return (
    meta.settledAt !== undefined &&
    !isWorking(meta, now) &&
    activityAt(meta, thread) <= meta.settledAt
  );
}

/** Which section a conversation is in. Archived and snoozed come first: they hide it whatever else is true. */
export function bucketOf(meta: ThreadMeta, thread: ThreadFacts, now: number): Bucket {
  if (meta.archivedAt !== undefined) return 'archived';
  if (isSnoozed(meta, now)) return 'snoozed';
  if (isSettled(meta, thread, now)) return 'done';
  if (meta.pinnedAt !== undefined) return 'pinned';
  if (isWorking(meta, now)) return 'working';
  return 'inbox';
}

export function statusOf(meta: ThreadMeta, now: number): RowStatus {
  if (isWorking(meta, now)) return 'working';
  const visited = meta.visitedAt ?? 0;
  if ((meta.failedAt ?? 0) > visited) return 'failed';
  if ((meta.completedAt ?? 0) > visited) return 'unread';
  if (hasWoken(meta, now)) return 'woke';
  return null;
}

/** Conversations that need the person: a reply finished or failed since they last looked. */
export function needsAttention(meta: ThreadMeta, now: number): boolean {
  const status = statusOf(meta, now);
  return status === 'unread' || status === 'failed';
}

export const STATUS_LABEL: Record<NonNullable<RowStatus>, string> = {
  working: 'Working',
  failed: 'Failed',
  unread: 'New reply',
  woke: 'Woke',
};

// ── Snooze ──────────────────────────────────────────────────────────────────────────────────

export interface SnoozePreset {
  id: string;
  label: string;
  until: number;
}

const HOUR = 60 * 60 * 1000;

/** The wake times offered, in the person's own time zone: later today, tomorrow, next week. */
export function snoozePresets(now: Date = new Date()): SnoozePreset[] {
  const at = (days: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date.getTime();
  };
  const presets: SnoozePreset[] = [
    { id: '1h', label: 'In 1 hour', until: now.getTime() + HOUR },
    { id: '3h', label: 'In 3 hours', until: now.getTime() + 3 * HOUR },
  ];
  // "This evening" is only offered while it is more than an hour away, and not already tomorrow's.
  const evening = at(0, 18);
  if (evening - now.getTime() > HOUR)
    presets.push({ id: 'evening', label: 'This evening', until: evening });
  presets.push({ id: 'tomorrow', label: 'Tomorrow morning', until: at(1, 9) });
  // The next Monday, never today: from Monday it is a week away.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({ id: 'week', label: 'Next week', until: at(toMonday, 9) });
  return presets;
}

/** "3h", "2d", "40m": how long until a snooze ends, for a row. */
export function untilLabel(until: number, now: number): string {
  const minutes = Math.max(1, Math.round((until - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// ── Order ───────────────────────────────────────────────────────────────────────────────────

export interface InboxEntry {
  key: string;
  agentId: string;
  threadId: string;
  title: string;
  updatedAt: number;
  meta: ThreadMeta;
  bucket: Bucket;
  status: RowStatus;
}

/** The key a conversation is known by in the inbox. */
export const threadKey = (agentId: string, threadId: string) => `${agentId}/${threadId}`;

/** Conversations that need the person come first, then the most recent activity. */
export function compareInbox(a: InboxEntry, b: InboxEntry, now: number): number {
  const needs = Number(needsAttention(b.meta, now)) - Number(needsAttention(a.meta, now));
  if (needs !== 0) return needs;
  return activityAt(b.meta, b) - activityAt(a.meta, a);
}

/** Pinned ones keep the order they were pinned in. */
export const comparePinned = (a: InboxEntry, b: InboxEntry) =>
  (a.meta.pinnedAt ?? 0) - (b.meta.pinnedAt ?? 0);

export const compareSnoozed = (a: InboxEntry, b: InboxEntry) =>
  (a.meta.snoozedUntil ?? 0) - (b.meta.snoozedUntil ?? 0);

export const compareSettled = (a: InboxEntry, b: InboxEntry) =>
  (b.meta.settledAt ?? 0) - (a.meta.settledAt ?? 0);

export const compareArchived = (a: InboxEntry, b: InboxEntry) =>
  (b.meta.archivedAt ?? 0) - (a.meta.archivedAt ?? 0);

/** The next moment a snooze ends, so one timer can wake the list. */
export function nextWake(metas: Iterable<ThreadMeta>, now: number): number | null {
  let next: number | null = null;
  for (const meta of metas)
    if (
      meta.snoozedUntil !== undefined &&
      meta.snoozedUntil > now &&
      (next === null || meta.snoozedUntil < next)
    )
      next = meta.snoozedUntil;
  return next;
}

export interface Sections {
  pinned: InboxEntry[];
  working: InboxEntry[];
  inbox: InboxEntry[];
  snoozed: InboxEntry[];
  done: InboxEntry[];
  archived: InboxEntry[];
}

/** Sorts entries into the sidebar's sections. */
export function sectionsOf(entries: InboxEntry[], now: number): Sections {
  const out: Sections = { pinned: [], working: [], inbox: [], snoozed: [], done: [], archived: [] };
  for (const entry of entries) out[entry.bucket].push(entry);
  out.pinned.sort(comparePinned);
  out.working.sort((a, b) => compareInbox(a, b, now));
  out.inbox.sort((a, b) => compareInbox(a, b, now));
  out.snoozed.sort(compareSnoozed);
  out.done.sort(compareSettled);
  out.archived.sort(compareArchived);
  return out;
}

// ── Changes ─────────────────────────────────────────────────────────────────────────────────

/** Each change a person can make, as a pure function of the thread's meta, so Undo can restore it. */
export const change = {
  pin: (meta: ThreadMeta, now: number): ThreadMeta => ({
    ...meta,
    pinnedAt: now,
    // Pinning means "I want this": it comes back from done, snoozed and archived.
    settledAt: undefined,
    snoozedUntil: undefined,
    snoozedAt: undefined,
    archivedAt: undefined,
  }),
  unpin: (meta: ThreadMeta): ThreadMeta => ({ ...meta, pinnedAt: undefined }),
  /** Done also lets go of a pin and a snooze: it is finished with. */
  settle: (meta: ThreadMeta, now: number): ThreadMeta => ({
    ...meta,
    settledAt: now,
    pinnedAt: undefined,
    snoozedUntil: undefined,
    snoozedAt: undefined,
  }),
  unsettle: (meta: ThreadMeta): ThreadMeta => ({ ...meta, settledAt: undefined }),
  snooze: (meta: ThreadMeta, until: number, now: number): ThreadMeta => ({
    ...meta,
    snoozedUntil: until,
    snoozedAt: now,
    pinnedAt: undefined,
    settledAt: undefined,
  }),
  wake: (meta: ThreadMeta): ThreadMeta => ({
    ...meta,
    snoozedUntil: undefined,
    snoozedAt: undefined,
  }),
  archive: (meta: ThreadMeta, now: number): ThreadMeta => ({
    ...meta,
    archivedAt: now,
    pinnedAt: undefined,
    snoozedUntil: undefined,
    snoozedAt: undefined,
  }),
  unarchive: (meta: ThreadMeta): ThreadMeta => ({ ...meta, archivedAt: undefined }),
  /** Looked at: whatever was new is seen, and a snooze that had ended is over. */
  visit: (meta: ThreadMeta, now: number): ThreadMeta => {
    const woken = meta.snoozedUntil !== undefined && meta.snoozedUntil <= now;
    return {
      ...meta,
      visitedAt: now,
      ...(woken ? { snoozedUntil: undefined, snoozedAt: undefined } : {}),
    };
  },
  /** Unread again: as if the last reply had not been seen. */
  markUnread: (meta: ThreadMeta, now: number): ThreadMeta => ({
    ...meta,
    completedAt: now,
    visitedAt: Math.min(meta.visitedAt ?? 0, now - 1),
  }),
  working: (meta: ThreadMeta, now: number): ThreadMeta =>
    meta.workingSince === undefined ? { ...meta, workingSince: now } : meta,
  finished: (meta: ThreadMeta, now: number, failed: boolean): ThreadMeta => ({
    ...meta,
    workingSince: undefined,
    completedAt: now,
    ...(failed ? { failedAt: now } : {}),
  }),
  /** Not working any more and nothing to report: it was deleted, or lost track of. */
  forgotten: (meta: ThreadMeta): ThreadMeta => ({ ...meta, workingSince: undefined }),
};

/** A meta with every field left undefined is not worth keeping. */
export function isBlank(meta: ThreadMeta): boolean {
  return Object.values(meta).every((value) => value === undefined);
}
