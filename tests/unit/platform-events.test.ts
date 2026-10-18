import { describe, expect, it } from 'vitest';
import type { AgentThread } from '../../src/api/client';
import { applyThreadEvent } from '../../src/hooks/use-platform-events';

const thread = (threadId: string, title = threadId): AgentThread => ({
  threadId,
  title,
  createdAt: 1,
  updatedAt: 1,
  busy: false,
  visibility: 'shared',
  participants: [],
});

describe('applyThreadEvent', () => {
  const list = [thread('a'), thread('b')];

  it('replaces a conversation in place', () => {
    const next = applyThreadEvent(list, {
      threadId: 'b',
      deleted: false,
      thread: { ...thread('b'), busy: true },
    });
    expect(next?.map((t) => [t.threadId, t.busy])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('adds a new conversation at the top', () => {
    expect(
      applyThreadEvent(list, { threadId: 'c', deleted: false, thread: thread('c') })?.map(
        (t) => t.threadId,
      ),
    ).toEqual(['c', 'a', 'b']);
  });

  it('removes a deleted one', () => {
    expect(
      applyThreadEvent(list, { threadId: 'a', deleted: true })?.map((t) => t.threadId),
    ).toEqual(['b']);
  });

  it('leaves a list that was never loaded alone', () => {
    expect(
      applyThreadEvent(undefined, { threadId: 'a', deleted: false, thread: thread('a') }),
    ).toBeUndefined();
  });
});
