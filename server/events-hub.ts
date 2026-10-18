import type { Platform } from './platform.ts';
import type { User } from './session.ts';

/**
 * One connection to the platform's event stream (`GET /v1/agents/events`),
 * shared by everyone signed in to this server. The service account sees every
 * agent the app manages, so each event goes only to the person whose agent it
 * is: it is matched with `isOwnAgent`, the same check every agent request
 * passes.
 *
 * The platform's stream says when a conversation is created, renamed, starts
 * or finishes a reply, or is deleted. Its `ready` carries no state, so after
 * the connection is made again (a platform restart, a network blip) listeners
 * are told to `resync`: events may have been missed, and their lists should be
 * read again.
 *
 * The connection opens with the first listener and closes a little after the
 * last one leaves, so a server nobody is using holds nothing open.
 */
export interface Listener {
  user: User;
  /** An SSE event: its name and its data (JSON). */
  send: (event: 'thread' | 'resync', data: string) => void;
}

export interface EventsHubOptions {
  /** First wait before connecting again; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** How long the connection stays open after the last listener leaves. */
  idleCloseMs?: number;
}

type HubPlatform = Pick<Platform, 'fetch' | 'isOwnAgent'>;

export class EventsHub {
  private readonly listeners = new Set<Listener>();
  private running = false;
  private abort: AbortController | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connections = 0;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly idleCloseMs: number;

  constructor(
    private readonly platform: HubPlatform,
    options: EventsHubOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
    this.idleCloseMs = options.idleCloseMs ?? 60_000;
  }

  /** Adds a listener; returns the function that removes it. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.running) void this.run();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && !this.idleTimer)
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.listeners.size === 0) this.close();
        }, this.idleCloseMs);
    };
  }

  /** Stops the connection now (on shutdown, or when nobody is listening). */
  close() {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
  }

  get listenerCount() {
    return this.listeners.size;
  }

  private async run() {
    this.running = true;
    let wait = this.retryMs;
    while (this.running && this.listeners.size > 0) {
      const abort = new AbortController();
      this.abort = abort;
      try {
        const response = await this.platform.fetch('/v1/agents/events', {
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          console.warn(`[events] the platform's event stream answered ${response.status}`);
          await response.body?.cancel().catch(() => undefined);
        } else {
          // Connected again after the first time: anything in between was missed.
          if (this.connections++ > 0) this.broadcast('resync', '{}');
          wait = this.retryMs;
          await this.read(response.body);
        }
      } catch (error) {
        if (!abort.signal.aborted) console.warn('[events] the platform event stream failed', error);
      }
      if (!this.running || this.listeners.size === 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, this.maxRetryMs);
    }
    this.running = false;
  }

  /** Reads server-sent events until the stream ends. */
  private async read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    let data: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line === '') {
            if (event === 'thread' && data.length > 0) void this.dispatch(data.join('\n'));
            event = 'message';
            data = [];
          } else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          // Comments (keep-alives) and other fields are ignored.
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Passes a thread event to the people whose agent it is about. */
  private async dispatch(data: string) {
    let agentId: unknown;
    try {
      agentId = (JSON.parse(data) as { agentId?: unknown }).agentId;
    } catch {
      return;
    }
    if (typeof agentId !== 'string') return;
    await Promise.all(
      [...this.listeners].map(async (listener) => {
        try {
          if (await this.platform.isOwnAgent(listener.user, agentId)) listener.send('thread', data);
        } catch {
          // The agent could not be looked up (deleted, the platform busy): skip this event.
        }
      }),
    );
  }

  private broadcast(event: 'resync', data: string) {
    for (const listener of this.listeners) listener.send(event, data);
  }
}
