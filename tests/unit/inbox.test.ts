import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  change,
  type InboxEntry,
  isBlank,
  nextWake,
  STALE_WORKING_MS,
  sectionsOf,
  snoozePresets,
  statusOf,
  type ThreadMeta,
  threadKey,
  untilLabel,
} from '../../src/lib/inbox';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 14, 10, 0).getTime(); // Wednesday 14 Oct 2026, 10:00 local
const thread = (updatedAt = NOW - 5 * HOUR) => ({ updatedAt });

describe('bucketOf', () => {
  it('puts an ordinary conversation in the inbox', () => {
    expect(bucketOf({}, thread(), NOW)).toBe('inbox');
  });

  it('pins, and shows work', () => {
    expect(bucketOf({ pinnedAt: NOW }, thread(), NOW)).toBe('pinned');
    expect(bucketOf({ workingSince: NOW - MIN }, thread(), NOW)).toBe('working');
  });

  it('keeps a pinned conversation pinned while it works', () => {
    expect(bucketOf({ pinnedAt: NOW, workingSince: NOW - MIN }, thread(), NOW)).toBe('pinned');
  });

  it('stops believing in work nobody has reported for hours', () => {
    expect(bucketOf({ workingSince: NOW - STALE_WORKING_MS - 1 }, thread(), NOW)).toBe('inbox');
  });

  it('archives and snoozes before anything else', () => {
    expect(bucketOf({ archivedAt: NOW, pinnedAt: NOW, workingSince: NOW }, thread(), NOW)).toBe(
      'archived',
    );
    expect(
      bucketOf({ snoozedUntil: NOW + HOUR, snoozedAt: NOW, pinnedAt: NOW }, thread(), NOW),
    ).toBe('snoozed');
  });

  describe('snooze', () => {
    const snoozed: ThreadMeta = { snoozedUntil: NOW + 3 * HOUR, snoozedAt: NOW };

    it('ends at its time', () => {
      expect(bucketOf(snoozed, thread(), NOW + 3 * HOUR - 1)).toBe('snoozed');
      expect(bucketOf(snoozed, thread(), NOW + 3 * HOUR)).toBe('inbox');
    });

    it('ends early when the agent finishes or fails', () => {
      expect(bucketOf({ ...snoozed, completedAt: NOW + MIN }, thread(), NOW + 2 * MIN)).toBe(
        'inbox',
      );
      expect(bucketOf({ ...snoozed, failedAt: NOW + MIN }, thread(), NOW + 2 * MIN)).toBe('inbox');
    });

    it('does not end for a reply that finished before it', () => {
      expect(bucketOf({ ...snoozed, completedAt: NOW - MIN }, thread(), NOW + MIN)).toBe('snoozed');
    });
  });

  describe('done', () => {
    it('stays done while nothing new happens', () => {
      expect(bucketOf({ settledAt: NOW }, thread(NOW - HOUR), NOW + HOUR)).toBe('done');
    });

    it('comes back for a newer message, a finished reply, or work', () => {
      expect(bucketOf({ settledAt: NOW }, thread(NOW + MIN), NOW + HOUR)).toBe('inbox');
      expect(
        bucketOf({ settledAt: NOW, completedAt: NOW + MIN }, thread(NOW - HOUR), NOW + HOUR),
      ).toBe('inbox');
      expect(
        bucketOf({ settledAt: NOW, workingSince: NOW + MIN }, thread(NOW - HOUR), NOW + HOUR),
      ).toBe('working');
    });
  });
});

describe('statusOf', () => {
  it('is nothing for a conversation that is quiet', () => {
    expect(statusOf({ visitedAt: NOW }, NOW)).toBeNull();
    expect(statusOf({}, NOW)).toBeNull();
  });

  it('puts work first, then failure, then a new reply', () => {
    const all = { workingSince: NOW, failedAt: NOW, completedAt: NOW, visitedAt: NOW - HOUR };
    expect(statusOf(all, NOW)).toBe('working');
    expect(statusOf({ ...all, workingSince: undefined }, NOW)).toBe('failed');
    expect(statusOf({ ...all, workingSince: undefined, failedAt: undefined }, NOW)).toBe('unread');
  });

  it('is seen once the conversation is visited', () => {
    const meta = { completedAt: NOW, visitedAt: NOW - MIN };
    expect(statusOf(meta, NOW)).toBe('unread');
    expect(statusOf(change.visit(meta, NOW + MIN), NOW + MIN)).toBeNull();
  });

  it('says a snooze has woken, until it is looked at', () => {
    const meta = { snoozedUntil: NOW, snoozedAt: NOW - HOUR, visitedAt: NOW - 2 * HOUR };
    expect(statusOf(meta, NOW + MIN)).toBe('woke');
    expect(statusOf(change.visit(meta, NOW + MIN), NOW + MIN)).toBeNull();
  });
});

describe('snoozePresets', () => {
  const labels = (date: Date) => snoozePresets(date).map((preset) => preset.id);

  it('offers this evening only while it is more than an hour away', () => {
    expect(labels(new Date(2026, 9, 14, 10, 0))).toContain('evening');
    expect(labels(new Date(2026, 9, 14, 17, 30))).not.toContain('evening');
    expect(labels(new Date(2026, 9, 14, 20, 0))).not.toContain('evening');
  });

  it('wakes tomorrow at nine and next week on Monday at nine', () => {
    const presets = snoozePresets(new Date(2026, 9, 14, 10, 0)); // a Wednesday
    const tomorrow = new Date(presets.find((preset) => preset.id === 'tomorrow')!.until);
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([15, 9]);
    const week = new Date(presets.find((preset) => preset.id === 'week')!.until);
    expect([week.getDay(), week.getDate(), week.getHours()]).toEqual([1, 19, 9]);
  });

  it('never makes next week today: from a Monday it is the Monday after', () => {
    const monday = new Date(2026, 9, 12, 10, 0);
    const week = new Date(snoozePresets(monday).find((preset) => preset.id === 'week')!.until);
    expect([week.getDay(), week.getDate()]).toEqual([1, 19]);
    const sunday = new Date(2026, 9, 18, 10, 0);
    const fromSunday = new Date(
      snoozePresets(sunday).find((preset) => preset.id === 'week')!.until,
    );
    expect([fromSunday.getDay(), fromSunday.getDate()]).toEqual([1, 19]);
  });

  it('only offers times in the future, in order', () => {
    const presets = snoozePresets(new Date(2026, 9, 14, 23, 30));
    for (const preset of presets)
      expect(preset.until).toBeGreaterThan(new Date(2026, 9, 14, 23, 30).getTime());
    expect(presets.map((preset) => preset.until)).toEqual(
      [...presets.map((preset) => preset.until)].sort((a, b) => a - b),
    );
  });
});

describe('untilLabel', () => {
  it('reads minutes, hours and days', () => {
    expect(untilLabel(NOW + 30 * MIN, NOW)).toBe('30m');
    expect(untilLabel(NOW + 3 * HOUR, NOW)).toBe('3h');
    expect(untilLabel(NOW + 50 * HOUR, NOW)).toBe('2d');
    expect(untilLabel(NOW + 1000, NOW)).toBe('1m');
  });
});

describe('changes', () => {
  it('pinning brings a conversation back from done, snoozed and archived', () => {
    const meta = { settledAt: 1, snoozedUntil: NOW + HOUR, snoozedAt: 1, archivedAt: 1 };
    expect(bucketOf(change.pin(meta, NOW), thread(), NOW)).toBe('pinned');
  });

  it('done lets go of a pin and a snooze', () => {
    const meta = change.settle({ pinnedAt: 1, snoozedUntil: NOW + HOUR, snoozedAt: 1 }, NOW);
    expect(bucketOf(meta, thread(NOW - HOUR), NOW)).toBe('done');
  });

  it('is reversible: Undo restores the meta it was given', () => {
    const before: ThreadMeta = { pinnedAt: 5, visitedAt: 9 };
    const after = change.settle(before, NOW);
    expect(bucketOf(after, thread(), NOW)).toBe('done');
    // The caller keeps `before` for Undo.
    expect(bucketOf(before, thread(), NOW)).toBe('pinned');
  });

  it('marks unread by rewinding the visit', () => {
    const meta = change.markUnread({ visitedAt: NOW }, NOW);
    expect(statusOf(meta, NOW)).toBe('unread');
  });

  it('records work and its end', () => {
    const working = change.working({}, NOW);
    expect(working.workingSince).toBe(NOW);
    expect(change.working(working, NOW + MIN).workingSince).toBe(NOW); // already started
    const done = change.finished(working, NOW + MIN, false);
    expect(done).toMatchObject({ workingSince: undefined, completedAt: NOW + MIN });
    expect(done.failedAt).toBeUndefined();
    expect(change.finished(working, NOW + MIN, true).failedAt).toBe(NOW + MIN);
  });

  it('knows a meta with nothing left in it', () => {
    expect(isBlank({})).toBe(true);
    // Pinned and unpinned again: every field is undefined, so there is nothing to keep.
    expect(isBlank(change.unpin(change.pin({}, NOW)))).toBe(true);
    expect(isBlank({ visitedAt: NOW })).toBe(false);
  });
});

describe('sectionsOf', () => {
  const entry = (id: string, meta: ThreadMeta, updatedAt = NOW - 5 * HOUR): InboxEntry => ({
    key: threadKey('a', id),
    agentId: 'a',
    threadId: id,
    title: id,
    updatedAt,
    meta,
    bucket: bucketOf(meta, { updatedAt }, NOW),
    status: statusOf(meta, NOW),
  });

  it('puts what needs the person first, then the newest', () => {
    const sections = sectionsOf(
      [
        entry('old', {}, NOW - 9 * HOUR),
        entry('new', {}, NOW - HOUR),
        entry('unread', { completedAt: NOW - 3 * HOUR, visitedAt: NOW - 4 * HOUR }, NOW - 8 * HOUR),
      ],
      NOW,
    );
    expect(sections.inbox.map((row) => row.threadId)).toEqual(['unread', 'new', 'old']);
  });

  it('orders snoozed by wake time, pinned by when pinned, done by when done', () => {
    const sections = sectionsOf(
      [
        entry('late', { snoozedUntil: NOW + 5 * HOUR, snoozedAt: NOW }),
        entry('soon', { snoozedUntil: NOW + HOUR, snoozedAt: NOW }),
        entry('p2', { pinnedAt: NOW - MIN }),
        entry('p1', { pinnedAt: NOW - HOUR }),
        entry('d1', { settledAt: NOW - HOUR }),
        entry('d2', { settledAt: NOW - MIN }),
      ],
      NOW,
    );
    expect(sections.snoozed.map((row) => row.threadId)).toEqual(['soon', 'late']);
    expect(sections.pinned.map((row) => row.threadId)).toEqual(['p1', 'p2']);
    expect(sections.done.map((row) => row.threadId)).toEqual(['d2', 'd1']);
  });
});

describe('nextWake', () => {
  it('is the earliest snooze still to end', () => {
    expect(
      nextWake(
        [
          { snoozedUntil: NOW + 3 * HOUR },
          { snoozedUntil: NOW + HOUR },
          { snoozedUntil: NOW - 1 },
          {},
        ],
        NOW,
      ),
    ).toBe(NOW + HOUR);
    expect(nextWake([{}, { snoozedUntil: NOW - HOUR }], NOW)).toBeNull();
  });
});
