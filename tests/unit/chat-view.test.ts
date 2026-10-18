import { describe, expect, it } from 'vitest';
import type { ChatView } from '~/api/client';
import {
  type PendingMessage,
  reuseUnchanged,
  toolOutputText,
  userMessagesWithText,
  viewToMessages,
} from '~/lib/chat-view';
import { parseEvent } from '~/lib/sse';

const transcript: ChatView = {
  busy: false,
  tools: [],
  messages: [
    { id: 'e1', role: 'user', text: 'List the files' },
    {
      id: 'e2',
      role: 'assistant',
      text: 'Let me look.',
      thinking: 'I should run ls.',
      toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
    },
    { id: 'e3', role: 'tool', toolCallId: 'c1', name: 'bash', text: 'a.ts\nb.ts', isError: false },
    { id: 'e4', role: 'assistant', text: 'There are two files.' },
  ],
};

describe('viewToMessages', () => {
  it('folds a reply’s steps and tool results into one assistant message, in order', () => {
    const messages = viewToMessages(transcript);
    expect(messages.map((message) => [message.id, message.role])).toEqual([
      ['e1', 'user'],
      ['reply-e1', 'assistant'],
    ]);
    const reply = messages[1]!;
    expect(reply.parts.map((part) => part.type)).toEqual([
      'reasoning',
      'text',
      'dynamic-tool',
      'text',
    ]);
    const tool = reply.parts[2] as Record<string, unknown>;
    expect(tool).toMatchObject({
      toolName: 'bash',
      toolCallId: 'c1',
      state: 'output-available',
      input: { command: 'ls' },
    });
    expect(toolOutputText(tool)).toBe('a.ts\nb.ts');
  });

  it('marks failed tools and failed or interrupted replies', () => {
    const failed = viewToMessages({
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'go' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: {} }],
        },
        { id: 'e3', role: 'tool', toolCallId: 'c1', name: 'read', text: 'ENOENT', isError: true },
        { id: 'e4', role: 'assistant', text: '', error: 'rate limited' },
        { id: 'e5', role: 'user', text: 'again' },
        { id: 'e6', role: 'assistant', text: 'partial', error: 'Interrupted' },
      ],
    });
    expect(failed[1]!.parts[0]).toMatchObject({ state: 'output-error', errorText: 'ENOENT' });
    expect(failed[1]!.metadata).toEqual({ status: 'error', errorMessage: 'rate limited' });
    expect(failed[3]!.metadata).toEqual({ status: 'cancelled' });
  });

  it('adds the step being generated and running tools’ live output while busy', () => {
    const messages = viewToMessages({
      busy: true,
      messages: [
        { id: 'e1', role: 'user', text: 'build it' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'make' } }],
        },
      ],
      tools: [{ callId: 'c1', name: 'bash', status: 'running', output: 'compiling…' }],
      partial: { text: '', thinking: '' },
    });
    const reply = messages[1]!;
    expect(reply.id).toBe('reply-e1');
    expect(reply.metadata).toEqual({ status: 'streaming' });
    const tool = reply.parts[0] as Record<string, unknown>;
    expect(tool.state).toBe('input-available');
    expect(toolOutputText(tool)).toBe('compiling…');
  });

  it('gives the live reply the same id before and after its first step is committed', () => {
    const before = viewToMessages({
      busy: true,
      tools: [],
      messages: [{ id: 'e1', role: 'user', text: 'hi' }],
      partial: { text: 'Hel', thinking: '' },
    });
    const after = viewToMessages({
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'hi' },
        { id: 'e2', role: 'assistant', text: 'Hello' },
      ],
    });
    expect(before[1]!.id).toBe(after[1]!.id);
    expect(before[1]!.parts).toEqual([{ type: 'text', text: 'Hel', state: 'streaming' }]);
  });

  it('appends messages sent from this tab after the transcript, except failed ones', () => {
    const pending: PendingMessage[] = [
      { requestId: 'r1', text: 'next', state: 'queued', baseline: 0 },
      { requestId: 'r2', text: 'nope', state: 'failed', baseline: 0 },
    ];
    const messages = viewToMessages(transcript, pending);
    expect(messages.at(-1)).toMatchObject({
      id: 'pending-r1',
      role: 'user',
      metadata: { pending: 'queued' },
    });
    expect(messages).toHaveLength(3);
  });
});

describe('reuseUnchanged', () => {
  it('keeps unchanged message objects so memoized rows do not re-render', () => {
    const first = viewToMessages(transcript);
    const second = viewToMessages({ ...transcript });
    const merged = reuseUnchanged(first, second);
    expect(merged).toBe(first);

    const third = viewToMessages({
      ...transcript,
      messages: [...transcript.messages, { id: 'e5', role: 'user', text: 'thanks' }],
    });
    const next = reuseUnchanged(first, third);
    expect(next).not.toBe(first);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
  });
});

describe('userMessagesWithText', () => {
  it('counts the user messages with exactly that text', () => {
    expect(userMessagesWithText(transcript, '  List the files ')).toBe(1);
    expect(userMessagesWithText(transcript, 'other')).toBe(0);
    expect(userMessagesWithText(null, 'x')).toBe(0);
  });
});

describe('parseEvent', () => {
  it('reads named events, multi-line data, and skips comments', () => {
    expect(parseEvent('event: view\ndata: {"a":1}')).toEqual({ event: 'view', data: '{"a":1}' });
    expect(parseEvent('data: one\ndata: two')).toEqual({ event: 'message', data: 'one\ntwo' });
    expect(parseEvent(': keep-alive')).toBeNull();
  });
});
