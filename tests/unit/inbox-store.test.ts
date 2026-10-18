import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inboxActionsFor } from '../../src/hooks/use-inbox';
import { InboxStore } from '../../src/lib/inbox-store';

/** A Storage that lives in memory, so two stores can share one "browser". */
function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

let disk: Storage;
beforeEach(() => {
  disk = memory();
});

describe('InboxStore', () => {
  it('saves changes and reads them back in a new session', () => {
    const first = new InboxStore('tim', disk);
    first.set('a/1', { pinnedAt: 5 });
    expect(new InboxStore('tim', disk).get('a/1')).toEqual({ pinnedAt: 5 });
  });

  it('keeps people who share a browser apart', () => {
    new InboxStore('tim', disk).set('a/1', { pinnedAt: 5 });
    expect(new InboxStore('bob', disk).getSnapshot()).toEqual({});
  });

  it('forgets a conversation set to nothing, or to a meta with nothing in it', () => {
    const store = new InboxStore('tim', disk);
    store.set('a/1', { pinnedAt: 5 });
    store.set('a/1', { pinnedAt: undefined });
    expect(store.get('a/1')).toBeUndefined();
    store.set('a/2', { pinnedAt: 5 });
    store.set('a/2', undefined);
    expect(store.getSnapshot()).toEqual({});
  });

  it('notifies only when something changed, with a new snapshot each time', () => {
    const store = new InboxStore('tim', disk);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.set('a/1', { pinnedAt: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    store.set('a/1', { pinnedAt: 5 }); // the same again
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives unreadable or foreign saved data', () => {
    disk.setItem('pai.inbox.tim', '{not json');
    expect(new InboxStore('tim', disk).getSnapshot()).toEqual({});
    disk.setItem('pai.inbox.tim', JSON.stringify({ v: 99, threads: { 'a/1': {} } }));
    expect(new InboxStore('tim', disk).getSnapshot()).toEqual({});
  });

  it('works when storage is unavailable, for the life of the page', () => {
    const store = new InboxStore('tim', null);
    store.set('a/1', { pinnedAt: 5 });
    expect(store.get('a/1')).toEqual({ pinnedAt: 5 });
  });

  it('clears everything of a person', () => {
    const store = new InboxStore('tim', disk);
    store.set('a/1', { pinnedAt: 5 });
    store.clear();
    expect(store.getSnapshot()).toEqual({});
    expect(new InboxStore('tim', disk).getSnapshot()).toEqual({});
  });

  describe('prune', () => {
    const NOW = 1_000_000_000;
    const GRACE = 10 * 60_000;

    it('forgets old state of conversations the list no longer has', () => {
      const store = new InboxStore('tim', disk);
      store.set('a/gone', { visitedAt: NOW - GRACE - 1 });
      store.set('a/here', { visitedAt: NOW - GRACE - 1 });
      store.set('b/other', { visitedAt: NOW - GRACE - 1 });
      store.prune('a', new Set(['here']), NOW, GRACE);
      expect(Object.keys(store.getSnapshot()).sort()).toEqual(['a/here', 'b/other']);
    });

    it('keeps recent state: a new conversation may not be listed yet', () => {
      const store = new InboxStore('tim', disk);
      store.set('a/new', { workingSince: NOW - 1000 });
      store.prune('a', new Set(), NOW, GRACE);
      expect(store.get('a/new')).toBeDefined();
    });
  });
});

describe('inboxActionsFor', () => {
  it('returns what was there before, so a change can be undone', () => {
    const store = new InboxStore('tim', disk);
    const actions = inboxActionsFor(store);
    actions.pin('a/1');
    const before = actions.settle('a/1');
    expect(before?.pinnedAt).toBeDefined();
    expect(store.get('a/1')?.settledAt).toBeDefined();
    actions.restore('a/1', before);
    expect(store.get('a/1')).toEqual(before);
  });

  it('does not save a visit again and again while a conversation streams', () => {
    const store = new InboxStore('tim', disk);
    const listener = vi.fn();
    store.subscribe(listener);
    const actions = inboxActionsFor(store);
    actions.visit('a/1');
    for (let i = 0; i < 50; i++) actions.visit('a/1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sees a reply that finished while it was open, at once', () => {
    const store = new InboxStore('tim', disk);
    const actions = inboxActionsFor(store);
    actions.visit('a/1');
    actions.working('a/1');
    actions.finished('a/1', false);
    expect(store.get('a/1')).toMatchObject({ completedAt: expect.any(Number) });
    actions.visit('a/1'); // not throttled: there is something new to see
    const meta = store.get('a/1')!;
    expect(meta.visitedAt!).toBeGreaterThanOrEqual(meta.completedAt!);
  });
});
