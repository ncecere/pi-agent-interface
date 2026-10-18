import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Agent, AgentThread } from '~/api/client';
import { AgentAvatar, agentStatusLabel } from '~/components/agent/agent-avatar';
import { Spinner } from '~/components/ui/spinner';
import { chattable, useAgents, useAgentThreads, useDeleteThread } from '~/hooks/use-agents';
import { useExpandedAgents } from '~/hooks/use-expanded-agents';
import { focusComposerSoon } from '~/lib/focus-after-navigation';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import { cn } from '~/lib/utils';

/** Conversations shown under an agent before "Show more". */
const SHOWN = 8;

const ROW_ACTION =
  'rounded p-1 text-[var(--text-muted)] enabled:hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The sidebar: every agent as a disclosure with its conversations under it.
 *
 * Listing an agent's conversations wakes its runtime, so they are loaded
 * only for agents that are open: ones opened by hand (remembered in this
 * browser) and the agent of the conversation on screen.
 */
export function SidebarAgents({ filter }: { filter: string }) {
  const { data, isLoading, isError } = useAgents();
  const agents = useMemo(() => chattable(data), [data]);
  const params = useParams({ strict: false }) as { agentId?: string; threadId?: string };
  const { expanded, toggle } = useExpandedAgents(agents);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const auto = params.agentId && params.agentId !== dismissed ? params.agentId : undefined;
  const isExpanded = (id: string) => expanded.has(id) || id === auto;

  function handleToggle(id: string) {
    const was = isExpanded(id);
    if (was && id === auto) setDismissed(id);
    if (!was && id === dismissed) setDismissed(null);
    toggle(id, !was);
  }

  const query = filter.trim().toLowerCase();
  const visible = query
    ? agents.filter((agent) => agent.name.toLowerCase().includes(query) || isExpanded(agent.id))
    : agents;

  if (isLoading)
    return (
      <div className="py-8">
        <Spinner className="mx-auto" />
      </div>
    );
  if (isError)
    return (
      <p className="px-2.5 py-1 text-xs text-[var(--text-muted)]">Agents could not be loaded.</p>
    );
  if (agents.length === 0)
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        Your team's agents will appear here.
      </p>
    );

  return (
    <section aria-labelledby="sidebar-agents-heading">
      <h2
        id="sidebar-agents-heading"
        className="px-2.5 pb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]"
      >
        Agents
      </h2>
      <ul className="flex flex-col gap-0.5" aria-label="Agents">
        {visible.map((agent) => (
          <AgentItem
            key={agent.id}
            agent={agent}
            active={params.agentId === agent.id && !params.threadId}
            expanded={isExpanded(agent.id)}
            onToggle={() => handleToggle(agent.id)}
            openThreadId={params.agentId === agent.id ? params.threadId : undefined}
            filter={query}
          />
        ))}
      </ul>
      {query && visible.length === 0 && (
        <p className="px-2.5 py-2 text-xs text-[var(--text-muted)]">No agents match.</p>
      )}
    </section>
  );
}

function AgentItem({
  agent,
  active,
  expanded,
  onToggle,
  openThreadId,
  filter,
}: {
  agent: Agent;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  openThreadId: string | undefined;
  filter: string;
}) {
  const navigate = useNavigate();
  const listId = `sidebar-agent-${agent.id}`;
  return (
    <li>
      <div
        className={cn(
          'group flex min-w-0 items-center rounded-lg transition-colors',
          active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`Conversations with ${agent.name}`}
          title={expanded ? 'Hide conversations' : 'Show conversations'}
          onClick={onToggle}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
        <Link
          to="/"
          search={{ agent: agent.id }}
          aria-current={active ? 'page' : undefined}
          title={`${agent.name} · ${agentStatusLabel(agent)}`}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-1 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <AgentAvatar agent={agent} size="sm" showStatus />
          <span className="min-w-0 truncate">{agent.name}</span>
        </Link>
        <button
          type="button"
          aria-label={`New chat with ${agent.name}`}
          title="New chat"
          onClick={async () => {
            await navigate({ to: '/', search: { agent: agent.id } });
            focusComposerSoon();
          }}
          className={cn(
            ROW_ACTION,
            'mr-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <div id={listId} hidden={!expanded}>
        {expanded && <AgentThreads agent={agent} openThreadId={openThreadId} filter={filter} />}
      </div>
    </li>
  );
}

function AgentThreads({
  agent,
  openThreadId,
  filter,
}: {
  agent: Agent;
  openThreadId: string | undefined;
  filter: string;
}) {
  const { data: threads, isLoading, isError, refetch } = useAgentThreads(agent.id);
  const [all, setAll] = useState(false);
  // Retried by itself while the agent is starting or the platform restarts.
  useEffect(() => {
    if (!isError) return;
    const timer = setTimeout(() => void refetch(), 5_000);
    return () => clearTimeout(timer);
  }, [isError, refetch]);

  const matching = filter
    ? (threads ?? []).filter((thread) => thread.title.toLowerCase().includes(filter))
    : (threads ?? []);
  const shown = all ? matching : matching.slice(0, SHOWN);
  // The conversation on screen stays listed even when older than the newest few.
  const open = openThreadId && matching.find((thread) => thread.threadId === openThreadId);
  if (open && !shown.includes(open)) shown.push(open);

  return (
    <div className="ml-4 border-l border-[var(--border-subtle)] pl-1.5">
      {isLoading ? (
        <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
          {agent.running ? 'Loading…' : `Waking ${agent.name}…`}
        </p>
      ) : isError ? (
        <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
          Conversations could not be loaded. Trying again…
        </p>
      ) : shown.length === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
          {filter ? 'No conversations match.' : 'No conversations yet.'}
        </p>
      ) : (
        <ul aria-label={`Conversations with ${agent.name}`} className="flex flex-col gap-0.5">
          {shown.map((thread) => (
            <li key={thread.threadId}>
              <ThreadRow
                agentId={agent.id}
                thread={thread}
                active={thread.threadId === openThreadId}
              />
            </li>
          ))}
        </ul>
      )}
      {matching.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="block w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
        >
          {all ? 'Show fewer' : `Show all (${matching.length})`}
        </button>
      )}
    </div>
  );
}

/** One conversation, with Delete (confirmed: the platform removes it for good). */
function ThreadRow({
  agentId,
  thread,
  active,
}: {
  agentId: string;
  thread: AgentThread;
  active: boolean;
}) {
  const remove = useDeleteThread();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <div
      data-focus-row=""
      className={cn(
        'group relative flex items-center rounded-lg transition-colors',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
      )}
    >
      <Link
        to="/agents/$agentId/threads/$threadId"
        params={{ agentId, threadId: thread.threadId }}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
        title={thread.title}
      >
        <span dir="auto" className="min-w-0 flex-1 truncate">
          {thread.title}
        </span>
      </Link>
      <div
        className={cn(
          'pointer-events-none absolute right-1 flex translate-x-3 items-center gap-0.5 rounded-lg bg-inherit pl-2 opacity-0',
          'transition-[transform,opacity] duration-200 ease-out',
          'group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100',
          'group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100',
          confirming && 'pointer-events-auto translate-x-0 opacity-100',
          'motion-reduce:transform-none motion-reduce:transition-none',
        )}
      >
        {confirming ? (
          <button
            type="button"
            aria-label={`Confirm delete conversation: ${thread.title}`}
            onClick={(event) => {
              const row = event.currentTarget.closest<HTMLElement>('[data-focus-row]');
              if (row) keepFocusWhenRemoved(row);
              remove.mutate({ agentId, threadId: thread.threadId });
              if (active) void navigate({ to: '/', search: { agent: agentId } });
            }}
            className="rounded bg-[var(--danger)]/20 px-2 py-0.5 text-xs font-medium text-[var(--danger-on-tint)] hover:bg-[var(--danger)]/30"
          >
            Delete
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Delete conversation: ${thread.title}`}
            title="Delete"
            onClick={() => setConfirming(true)}
            className={ROW_ACTION}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
