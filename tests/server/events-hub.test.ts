// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EventsHub } from '../../server/events-hub.ts';

const TIM_AGENT = 'agent-tim';
const BOB_AGENT = 'agent-bob';
const tim = { id: 'tim', name: 'Tim', email: 'tim@example.test' };
const bob = { id: 'bob', name: 'Bob', email: 'bob@example.test' };

/** A platform whose event stream the test writes to; each connection is a new stream. */
function fakePlatform() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let connects = 0;
  let aborted = 0;
  const encoder = new TextEncoder();
  return {
    get connects() {
      return connects;
    },
    get aborted() {
      return aborted;
    },
    async fetch(path: string, init: RequestInit = {}) {
      expect(path).toBe('/v1/agents/events');
      connects++;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));
        },
      });
      init.signal?.addEventListener('abort', () => {
        aborted++;
        try {
          streams.at(-1)?.error(new Error('aborted'));
        } catch {
          // closed already
        }
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    },
    async isOwnAgent(user: { id: string }, agentId: string) {
      return agentId === `agent-${user.id}`;
    },
    /** Writes to the current connection, split across chunks as a network might. */
    emit(text: string) {
      const bytes = encoder.encode(text);
      const middle = Math.floor(bytes.length / 2);
      streams.at(-1)!.enqueue(bytes.slice(0, middle));
      streams.at(-1)!.enqueue(bytes.slice(middle));
    },
    drop() {
      streams.at(-1)!.close();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const thread = (agentId: string, threadId: string) =>
  `event: thread\ndata: ${JSON.stringify({ agentId, threadId, deleted: false, thread: { threadId, busy: true } })}\n\n`;

describe('EventsHub', () => {
  it('gives each person only the events of their own agents', async () => {
    const platform = fakePlatform();
    const hub = new EventsHub(platform, { retryMs: 5, idleCloseMs: 5 });
    const got: Record<string, string[]> = { tim: [], bob: [] };
    const stopTim = hub.subscribe({
      user: tim,
      send: (_e, data) => got.tim!.push(JSON.parse(data).threadId),
    });
    const stopBob = hub.subscribe({
      user: bob,
      send: (_e, data) => got.bob!.push(JSON.parse(data).threadId),
    });
    await settle();
    expect(platform.connects).toBe(1); // one connection for everyone
    platform.emit(thread(TIM_AGENT, 't1'));
    platform.emit(': keep-alive\n\n');
    platform.emit(thread(BOB_AGENT, 'b1'));
    platform.emit(thread('agent-someone-else', 'x1'));
    await settle();
    expect(got).toEqual({ tim: ['t1'], bob: ['b1'] });
    stopTim();
    stopBob();
    hub.close();
  });

  it('connects again when the platform ends the stream, and asks listeners to resync', async () => {
    const platform = fakePlatform();
    const hub = new EventsHub(platform, { retryMs: 5, idleCloseMs: 5 });
    const events: string[] = [];
    const stop = hub.subscribe({ user: tim, send: (event) => events.push(event) });
    await settle();
    platform.drop();
    await settle();
    expect(platform.connects).toBe(2);
    expect(events).toEqual(['resync']);
    platform.emit(thread(TIM_AGENT, 't2'));
    await settle();
    expect(events).toEqual(['resync', 'thread']);
    stop();
    hub.close();
  });

  it('lets go of the connection once nobody is listening', async () => {
    const platform = fakePlatform();
    const hub = new EventsHub(platform, { retryMs: 5, idleCloseMs: 10 });
    const stop = hub.subscribe({ user: tim, send: () => undefined });
    await settle();
    stop();
    expect(hub.listenerCount).toBe(0);
    await settle();
    expect(platform.aborted).toBe(1); // the platform connection is closed
    await settle();
    expect(platform.connects).toBe(1); // and not opened again
  });
});
