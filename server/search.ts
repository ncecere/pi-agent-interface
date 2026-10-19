/**
 * Searching the text of messages (the `messageSearch` feature). The platform can search titles only (the app
 * does that in the browser), so the app keeps its own searchable copy of the messages of the conversations a person
 * opens through it: one row per person and conversation, in the app's database (store.ts `indexThread`).
 *
 * What is here is pure: what to index from a conversation, how a query becomes terms, how a match is shown, and how
 * the conversation's event stream is watched for what to index.
 */

/** A conversation's text is kept up to this many characters (the start; the rest of a very long one is not searched). */
export const MAX_INDEXED_CHARS = 200_000;
/** Words used from a query. */
const MAX_TERMS = 8;
/** Marks the matched words in a snippet (the browser turns them into <mark>). */
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

/** The parts of a chat view this reads. */
export interface ViewLike {
  busy?: boolean;
  messages?: Array<{ role?: string; text?: string }>;
}

/** What to index of a conversation: what people and the agent said, in order. Not thinking, tool output or errors. */
export function bodyOfView(view: ViewLike): string {
  const parts: string[] = [];
  let length = 0;
  for (const message of view.messages ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
    if (length >= MAX_INDEXED_CHARS) break;
  }
  return parts.join('\n').slice(0, MAX_INDEXED_CHARS);
}

/** The words of a query: letters and digits only, lower case, none empty, the first few. */
export function searchTerms(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS);
}

/**
 * A PostgreSQL tsquery for these terms: every word must be there, each as the start of a word ("expen" finds
 * "expense"). Terms hold only letters and digits, so nothing in them is an operator.
 */
export const tsQueryOf = (terms: readonly string[]): string =>
  terms.map((term) => `${term}:*`).join(' & ');

/** Whether a body holds all the terms, each as the start of a word (the in-memory store's search). */
export function matchesTerms(body: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const words = body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}

/** A line or so around the first match, the matched words between MARK_START and MARK_END. */
export function snippetOf(body: string, terms: readonly string[], width = 140): string {
  const flat = body.replace(/\s+/g, ' ');
  const pattern = terms.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${terms.map(escapeRegExp).join('|')})[\\p{L}\\p{N}]*`, 'iu')
    : null;
  const match = pattern?.exec(flat);
  const at = match?.index ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  let text = flat.slice(start, start + width);
  if (pattern) {
    // The whole word that matched, as PostgreSQL's ts_headline marks it.
    const all = new RegExp(pattern.source, 'giu');
    text = text.replace(all, (word) => `${MARK_START}${word}${MARK_END}`);
  }
  return `${start > 0 ? '…' : ''}${text}${start + width < flat.length ? '…' : ''}`;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Watches a conversation's server-sent events as they pass, and calls `onView` with each complete `view` (the
 * whole transcript so far). The bytes go on unchanged.
 */
export function tapViews(
  body: ReadableStream<Uint8Array>,
  onView: (view: ViewLike) => void,
  /** Once, when the stream ends however it ends. */
  onEnd: () => void = () => undefined,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '';
  const read = (chunk: Uint8Array) => {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf('\n\n');
    while (end >= 0) {
      const block = pending.slice(0, end);
      pending = pending.slice(end + 2);
      end = pending.indexOf('\n\n');
      const lines = block.split('\n');
      if (!lines.some((line) => line.trim() === 'event: view')) continue;
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      try {
        onView(JSON.parse(data) as ViewLike);
      } catch {
        // Not JSON: not ours to index.
      }
    }
    if (pending.length > 4_000_000) pending = ''; // never hold an unbounded block
  };
  const reader = body.getReader();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        end();
        throw error;
      }
      const { done, value } = chunk;
      if (done) {
        end();
        return controller.close();
      }
      try {
        if (value) read(value);
      } catch {
        // Indexing never costs the person their conversation.
      }
      if (value) controller.enqueue(value);
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
}

/** One match. */
export interface SearchHit {
  agentId: string;
  threadId: string;
  snippet: string;
  indexedAt: Date;
}
