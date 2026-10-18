import type { DynamicToolUIPart, UIMessage } from 'ai';
import type { ChatView, ChatViewMessage } from '~/api/client';

/**
 * Turns the platform's ChatView (pi's transcript plus the reply in progress)
 * into the AI SDK messages the Open Chat Interface renderers draw.
 *
 * Pi records a reply as a run of messages: an assistant message per model
 * step (thinking, text, tool calls), each followed by the tool results. The
 * interface shows a reply as one message whose parts keep that order, so
 * everything after a user message, up to the next one, becomes one assistant
 * message: reasoning, text, and a `dynamic-tool` part per call (its state and
 * output from the matching result). While the agent works, the step being
 * generated (`partial`) and the running tools' output (`tools`) are added to
 * the last reply.
 */

/** A message sent from this tab that is not in the transcript yet. */
export interface PendingMessage {
  /** Also the platform's idempotency key, so resending it cannot submit it twice. */
  requestId: string;
  text: string;
  /**
   * `sending`: the request is in flight. `queued`: accepted, waiting for the
   * agent to take it (after the reply it is working on). `failed`: refused or
   * unreachable; the text is back in the composer. `confirmed`: the transcript
   * has it; the entry stays so the message keeps the same identity (and DOM
   * row) as it moves from "sent from this tab" to "in the transcript".
   */
  state: 'sending' | 'queued' | 'failed' | 'confirmed';
  /** User messages with this text in the transcript when it was sent. */
  baseline: number;
  /** The transcript's id for it, once `confirmed`. */
  matchedId?: string;
}

/** The id a message sent from this tab keeps for its whole life on screen. */
export const pendingIdOf = (message: Pick<PendingMessage, 'requestId'>) =>
  `pending-${message.requestId}`;

/** Metadata on a reply, read by the renderers through metadataOf(). */
export interface ReplyMetadata {
  /** `cancelled` with no message: stopped. `error`: the model request failed. */
  status?: 'cancelled' | 'error' | 'streaming';
  errorMessage?: string;
  /** For a user message from this tab: where it is. */
  pending?: Exclude<PendingMessage['state'], 'failed' | 'confirmed'>;
}

export type AgentUIMessage = UIMessage<ReplyMetadata>;
type Part = AgentUIMessage['parts'][number];

/**
 * The id of the reply to the n-th user message (from 0): stable from the first
 * token to the last, and whatever id the question has (a message sent from
 * this tab is renamed by the transcript when it arrives).
 */
const replyIdFor = (turn: number) => (turn < 0 ? 'reply-start' : `reply-${turn}`);

/** Whether a message is one sent from this tab and not in the transcript yet. */
export const isPendingMessage = (message: { metadata?: unknown }) =>
  Boolean((message.metadata as ReplyMetadata | undefined)?.pending);

/** The output a tool part carries: pi's result text. */
export interface ToolOutput {
  text: string;
}

/** Live output of a running tool, kept on the part until its result arrives. */
export function liveOutputOf(part: { toolMetadata?: unknown }): string | null {
  const live = (part.toolMetadata as { liveOutput?: unknown } | undefined)?.liveOutput;
  return typeof live === 'string' ? live : null;
}

/** A tool result's text, or the live output while it runs. */
export function toolOutputText(part: Record<string, unknown>): string | null {
  const output = part.output as Partial<ToolOutput> | undefined;
  if (typeof output?.text === 'string') return output.text;
  if (typeof part.errorText === 'string') return part.errorText;
  return liveOutputOf(part as { toolMetadata?: unknown });
}

interface Reply {
  message: AgentUIMessage;
  tools: Map<string, DynamicToolUIPart>;
}

export function viewToMessages(
  view: ChatView | null,
  pending: readonly PendingMessage[] = [],
): AgentUIMessage[] {
  const messages: AgentUIMessage[] = [];
  let reply: Reply | null = null;
  let turn = -1;
  // Transcript id -> the id the message already has on screen.
  const alias = new Map<string, string>();
  for (const message of pending)
    if (message.state === 'confirmed' && message.matchedId)
      alias.set(message.matchedId, pendingIdOf(message));

  const currentReply = (): Reply => {
    if (!reply) {
      reply = {
        message: { id: replyIdFor(turn), role: 'assistant', parts: [], metadata: {} },
        tools: new Map(),
      };
      messages.push(reply.message);
    }
    return reply;
  };

  for (const message of view?.messages ?? []) {
    if (message.role === 'user') {
      reply = null;
      turn++;
      messages.push({
        id: alias.get(message.id) ?? message.id,
        role: 'user',
        parts: [{ type: 'text', text: message.text ?? '' }],
      });
    } else if (message.role === 'assistant') {
      addAssistantStep(currentReply(), message);
    } else if (message.role === 'tool') {
      addToolResult(currentReply(), message);
    }
  }

  if (view?.busy) {
    const live = currentReply();
    const parts = live.message.parts;
    const thinking = view.partial?.thinking ?? '';
    const text = view.partial?.text ?? '';
    if (thinking) parts.push({ type: 'reasoning', text: thinking, state: 'streaming' });
    if (text) parts.push({ type: 'text', text, state: 'streaming' });
    for (const slot of view.tools ?? []) {
      const part = live.tools.get(slot.callId);
      if (part && part.state === 'input-available') {
        if (slot.output) part.toolMetadata = { liveOutput: slot.output };
      } else if (!part) {
        // A tool running whose call is not committed yet: show it anyway.
        const added: DynamicToolUIPart = {
          type: 'dynamic-tool',
          toolName: slot.name,
          toolCallId: slot.callId,
          state: 'input-available',
          input: {},
          ...(slot.output ? { toolMetadata: { liveOutput: slot.output } } : {}),
        };
        live.tools.set(slot.callId, added);
        parts.push(added);
      }
    }
    // A reply being written carries no failure from an earlier step.
    live.message.metadata = { status: 'streaming' };
  }

  for (const message of pending) {
    if (message.state === 'failed' || message.state === 'confirmed') continue;
    messages.push({
      id: pendingIdOf(message),
      role: 'user',
      parts: [{ type: 'text', text: message.text }],
      metadata: { pending: message.state },
    });
  }

  return messages;
}

function addAssistantStep(reply: Reply, message: ChatViewMessage) {
  const parts = reply.message.parts;
  if (message.thinking) parts.push({ type: 'reasoning', text: message.thinking, state: 'done' });
  if (message.text) parts.push({ type: 'text', text: message.text, state: 'done' });
  for (const call of message.toolCalls ?? []) {
    const part: DynamicToolUIPart = {
      type: 'dynamic-tool',
      toolName: call.name,
      toolCallId: call.id,
      state: 'input-available',
      input: call.arguments ?? {},
    };
    reply.tools.set(call.id, part);
    parts.push(part);
  }
  // The latest step decides how the reply ended: a failure, then a retry that
  // worked, is a reply that worked.
  reply.message.metadata = message.error
    ? message.error === 'Interrupted'
      ? { status: 'cancelled' }
      : { status: 'error', errorMessage: message.error }
    : {};
}

function addToolResult(reply: Reply, message: ChatViewMessage) {
  const id = message.toolCallId ?? '';
  const text = message.text ?? '';
  const existing = reply.tools.get(id);
  const base = {
    type: 'dynamic-tool' as const,
    toolName: existing?.toolName ?? message.name ?? 'tool',
    toolCallId: id,
    input: existing?.input ?? {},
  };
  const done: DynamicToolUIPart = message.isError
    ? { ...base, state: 'output-error', errorText: text || 'The tool failed.' }
    : { ...base, state: 'output-available', output: { text } satisfies ToolOutput };
  if (existing) {
    const parts = reply.message.parts as Part[];
    const index = parts.indexOf(existing);
    if (index >= 0) parts[index] = done;
  } else {
    reply.message.parts.push(done);
  }
  reply.tools.set(id, done);
}

/**
 * The new messages, keeping the previous object for every message whose
 * content is unchanged. The renderers memoize rows by object identity, so a
 * transcript re-sent on every token only re-renders the reply being written.
 */
export function reuseUnchanged(
  previous: readonly AgentUIMessage[],
  next: AgentUIMessage[],
): AgentUIMessage[] {
  if (previous.length === 0) return next;
  const byId = new Map(previous.map((message) => [message.id, message]));
  let changed = previous.length !== next.length;
  const merged = next.map((message, index) => {
    const before = byId.get(message.id);
    if (before && sameMessage(before, message)) {
      if (previous[index] !== before) changed = true;
      return before;
    }
    changed = true;
    return message;
  });
  return changed ? merged : (previous as AgentUIMessage[]);
}

const signatures = new WeakMap<AgentUIMessage, string>();
function signature(message: AgentUIMessage): string {
  let value = signatures.get(message);
  if (value === undefined) {
    value = JSON.stringify(message);
    signatures.set(message, value);
  }
  return value;
}
const sameMessage = (a: AgentUIMessage, b: AgentUIMessage) => signature(a) === signature(b);

/** How many user messages in the transcript have exactly this text. */
export function userMessagesWithText(view: ChatView | null, text: string): number {
  const wanted = text.trim();
  return (view?.messages ?? []).filter(
    (message) => message.role === 'user' && (message.text ?? '').trim() === wanted,
  ).length;
}
