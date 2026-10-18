import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  CircleDot,
  Ellipsis,
  Pin,
  PinOff,
  Trash2,
  Undo2,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Agent } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteThread } from '~/hooks/use-agents';
import { type InboxActions, useInbox, useInboxActions } from '~/hooks/use-inbox';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import {
  activityAt,
  type InboxEntry,
  type Sections,
  STATUS_LABEL,
  snoozePresets,
  type ThreadMeta,
  untilLabel,
} from '~/lib/inbox';
import { cn } from '~/lib/utils';

const QUICK =
  'rounded p-1 text-[var(--text-muted)] enabled:hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40';

/** Which shelves are open, remembered in this browser. They start closed. */
const SHELVES_KEY = 'pai.inbox.shelves';
function useShelf(id: string): [boolean, (open: boolean) => void] {
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(SHELVES_KEY) ?? '{}')[id] === true;
    } catch {
      return false;
    }
  };
  const [open, setOpen] = useState(read);
  return [
    open,
    (next) => {
      setOpen(next);
      try {
        const all = JSON.parse(localStorage.getItem(SHELVES_KEY) ?? '{}');
        localStorage.setItem(SHELVES_KEY, JSON.stringify({ ...all, [id]: next }));
      } catch {
        // Storage blocked: lasts for this page only.
      }
    },
  ];
}

/**
 * The sidebar: every conversation of every agent, sorted by what it needs.
 * Pinned, then Working, then the Inbox; Snoozed, Done and Archived are shelves
 * that start closed. A change says what it did, with Undo.
 */
export function SidebarInbox({ filter }: { filter: string }) {
  const inbox = useInbox();
  const actions = useInboxActions();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { agentId?: string; threadId?: string };
  const openKey = params.agentId && params.threadId ? `${params.agentId}/${params.threadId}` : null;
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const multi = inbox.agents.length > 1;
  const agents = new Map(inbox.agents.map((agent) => [agent.id, agent]));

  const query = filter.trim().toLowerCase();
  const show = (entry: InboxEntry) =>
    (!agentFilter || entry.agentId === agentFilter) &&
    (!query || entry.title.toLowerCase().includes(query));
  const sections: Sections = {
    pinned: inbox.sections.pinned.filter(show),
    working: inbox.sections.working.filter(show),
    inbox: inbox.sections.inbox.filter(show),
    snoozed: inbox.sections.snoozed.filter(show),
    done: inbox.sections.done.filter(show),
    archived: inbox.sections.archived.filter(show),
  };
  const active = [...sections.pinned, ...sections.working, ...sections.inbox];

  /** Said, with a way back. */
  const undoable = (message: string, key: string, apply: () => ThreadMeta | undefined) => {
    const before = apply();
    toast(message, {
      duration: 6000,
      action: { label: 'Undo', onClick: () => actions.restore(key, before) },
    });
  };

  /** After finishing with the conversation on screen: the next one, or a new chat. */
  const advanceFrom = (entry: InboxEntry) => {
    if (openKey !== entry.key) return;
    const index = active.findIndex((candidate) => candidate.key === entry.key);
    const next = active
      .slice(index + 1)
      .concat(active.slice(0, Math.max(index, 0)))
      .find((c) => c.key !== entry.key);
    if (next)
      void navigate({
        to: '/agents/$agentId/threads/$threadId',
        params: { agentId: next.agentId, threadId: next.threadId },
      });
    else void navigate({ to: '/', search: { agent: entry.agentId } });
  };

  if (inbox.loading)
    return (
      <div className="py-8">
        <Spinner className="mx-auto" />
      </div>
    );
  if (inbox.failed)
    return (
      <p className="px-2.5 py-1 text-xs text-[var(--text-muted)]">
        Conversations could not be loaded.
      </p>
    );
  if (inbox.agents.length === 0)
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        Your agents will appear here.
      </p>
    );
  if (inbox.entries.length === 0)
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        Your conversations will appear here.
      </p>
    );

  const row = (entry: InboxEntry) => {
    const agent = agents.get(entry.agentId);
    return agent ? (
      <li key={entry.key}>
        <InboxRow
          entry={entry}
          agent={agent}
          active={openKey === entry.key}
          showAgent={multi}
          now={inbox.now}
          actions={actions}
          undoable={undoable}
          advance={() => advanceFrom(entry)}
        />
      </li>
    ) : null;
  };
  const list = (entries: InboxEntry[], label: string) =>
    entries.length > 0 && (
      <ul aria-label={label} className="flex flex-col gap-px">
        {entries.map(row)}
      </ul>
    );

  return (
    <div className="flex flex-col gap-3">
      {multi && (
        <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">Show conversations with</legend>
          {[
            { id: null, name: 'All' },
            ...inbox.agents.map((agent) => ({ id: agent.id, name: agent.name })),
          ].map((option) => (
            <button
              key={option.id ?? 'all'}
              type="button"
              aria-pressed={agentFilter === option.id}
              onClick={() => setAgentFilter(option.id)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                agentFilter === option.id
                  ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'bg-[var(--bg-control)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {option.name}
            </button>
          ))}
        </fieldset>
      )}

      {sections.pinned.length > 0 && (
        <section aria-labelledby="inbox-pinned">
          <Heading id="inbox-pinned">Pinned</Heading>
          {list(sections.pinned, 'Pinned conversations')}
        </section>
      )}
      {sections.working.length > 0 && (
        <section aria-labelledby="inbox-working">
          <Heading id="inbox-working">Working</Heading>
          {list(sections.working, 'Conversations the agent is working on')}
        </section>
      )}
      <section aria-labelledby="inbox-inbox">
        <Heading id="inbox-inbox">Inbox</Heading>
        {sections.inbox.length > 0 ? (
          list(sections.inbox, 'Inbox')
        ) : (
          <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
            {query || agentFilter ? 'No conversations match.' : 'All caught up.'}
          </p>
        )}
      </section>

      <div className="flex flex-col gap-1">
        <Shelf
          id="snoozed"
          label="Snoozed"
          entries={sections.snoozed}
          openKey={openKey}
          render={list}
        />
        <Shelf id="done" label="Done" entries={sections.done} openKey={openKey} render={list} />
        <Shelf
          id="archived"
          label="Archived"
          entries={sections.archived}
          openKey={openKey}
          render={list}
        />
      </div>
    </div>
  );
}

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2">
      <h2 id={id} className="text-xs font-medium text-[var(--text-muted)]">
        {children}
      </h2>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}

const STATUS_TONE: Record<NonNullable<InboxEntry['status']>, string> = {
  working: 'text-[oklch(0.72_0.13_240)]',
  failed: 'text-[var(--danger-on-tint)]',
  unread: 'text-[var(--success)]',
  woke: 'text-[var(--warning)]',
};

/** "12s", "4m", "1h 5m": how long the agent has been working, ticking. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{formatElapsed(now - since)}</span>;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
function ago(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

/** A collapsible section. Closed, it still shows the conversation that is open, so it never vanishes from under you. */
function Shelf({
  id,
  label,
  entries,
  openKey,
  render,
}: {
  id: string;
  label: string;
  entries: InboxEntry[];
  openKey: string | null;
  render: (entries: InboxEntry[], label: string) => ReactNode;
}) {
  const [open, setOpen] = useShelf(id);
  if (entries.length === 0) return null;
  const current = entries.filter((entry) => entry.key === openKey);
  const panel = `inbox-shelf-${id}`;
  return (
    <section aria-label={label}>
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={cn(
              'size-3 transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            aria-hidden="true"
          />
          <span>
            {label}
            {!open && <span className="font-normal"> ({entries.length})</span>}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
        </button>
      </h2>
      <div id={panel} className="mt-0.5">
        {open ? render(entries, label) : render(current, label)}
      </div>
    </section>
  );
}

function InboxRow({
  entry,
  agent,
  active,
  showAgent,
  now,
  actions,
  undoable,
  advance,
}: {
  entry: InboxEntry;
  agent: Agent;
  active: boolean;
  showAgent: boolean;
  now: number;
  actions: InboxActions;
  undoable: (message: string, key: string, apply: () => ThreadMeta | undefined) => void;
  advance: () => void;
}) {
  const remove = useDeleteThread();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirming) return;
    // The menu that asked is gone: keep focus on the question.
    confirmButton.current?.focus();
    const timer = setTimeout(() => setConfirming(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const { key, title, bucket, status, meta } = entry;
  const working = status === 'working';
  const avatarState =
    status === 'working'
      ? 'working'
      : status === 'failed'
        ? 'error'
        : status
          ? 'attention'
          : 'idle';
  const label =
    bucket === 'snoozed' && meta.snoozedUntil
      ? untilLabel(meta.snoozedUntil, now)
      : status
        ? STATUS_LABEL[status]
        : '';

  const done = () => {
    undoable('Marked done', key, () => actions.settle(key));
    advance();
  };
  const pin = () => undoable('Pinned', key, () => actions.pin(key));
  const unpin = () => undoable('Unpinned', key, () => actions.unpin(key));
  const snooze = (until: number) => {
    const when = new Date(until).toLocaleString([], {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    undoable(`Snoozed until ${when}`, key, () => actions.snooze(key, until));
    advance();
  };
  const archive = () => {
    undoable('Archived', key, () => actions.archive(key));
    advance();
  };
  const backToInbox = () => {
    if (bucket === 'archived') actions.unarchive(key);
    else if (bucket === 'snoozed') actions.wake(key);
    else actions.unsettle(key);
  };
  const del = (event: { currentTarget: HTMLElement }) => {
    const rowElement = event.currentTarget.closest<HTMLElement>('[data-focus-row]');
    if (rowElement) keepFocusWhenRemoved(rowElement);
    remove.mutate({ agentId: entry.agentId, threadId: entry.threadId });
    actions.restore(key, undefined);
    if (active) void navigate({ to: '/', search: { agent: entry.agentId } });
  };

  const presets = snoozePresets(new Date(now));
  const away = bucket === 'done' || bucket === 'snoozed' || bucket === 'archived';

  return (
    <div
      data-focus-row=""
      className={cn(
        'group relative flex rounded-md transition-[background-color,opacity]',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
        // Working rows recede until you look at them, as in t3code.
        working && !active && 'opacity-70 hover:opacity-100 focus-within:opacity-100',
      )}
    >
      <Link
        to="/agents/$agentId/threads/$threadId"
        params={{ agentId: entry.agentId, threadId: entry.threadId }}
        aria-current={active ? 'page' : undefined}
        title={title}
        className={cn(
          'flex min-w-0 flex-1 px-2.5 pointer-coarse:pr-9',
          away ? 'h-9 items-center gap-2.5' : 'flex-col justify-center gap-1 py-2',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {status || showAgent ? (
            <AgentAvatar
              agent={agent}
              size={16}
              state={avatarState}
              frozen={!status}
              className={cn(away && 'opacity-60')}
            />
          ) : null}
          <span
            dir="auto"
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              // Read and idle rows recede; what needs you stands out.
              status && status !== 'working'
                ? 'font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)]',
              active && 'font-medium text-[var(--text-primary)]',
              away && 'text-[var(--text-muted)]',
            )}
          >
            {title}
          </span>
          {label && (
            <span
              className={cn(
                'flex shrink-0 items-center gap-1 text-xs font-medium transition-opacity group-focus-within:opacity-0 group-hover:opacity-0',
                status ? STATUS_TONE[status] : 'text-[var(--text-muted)]',
              )}
            >
              <span className="sr-only">, </span>
              {label}
              {working && meta.workingSince !== undefined && <Elapsed since={meta.workingSince} />}
            </span>
          )}
        </span>
        {!away && (
          <span
            className={cn(
              'truncate text-xs text-[var(--text-muted)]',
              (status || showAgent) && 'pl-6',
            )}
          >
            {[showAgent ? agent.name : null, ago(activityAt(meta, entry), now)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </Link>

      <div
        className={cn(
          'pointer-events-none absolute right-1 flex translate-x-3 items-center gap-0.5 rounded-md bg-inherit pl-2 opacity-0',
          away ? 'top-1/2 -translate-y-1/2' : 'top-1.5',
          'transition-[transform,opacity] duration-200 ease-out',
          'group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100',
          'group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100',
          confirming && 'pointer-events-auto translate-x-0 opacity-100',
          // Touch screens have no hover: the "…" menu is always there.
          'pointer-coarse:pointer-events-auto pointer-coarse:translate-x-0 pointer-coarse:opacity-100',
          'motion-reduce:transform-none motion-reduce:transition-none',
        )}
      >
        {confirming ? (
          <button
            ref={confirmButton}
            type="button"
            aria-label={`Confirm delete conversation: ${title}`}
            onClick={del}
            className="rounded bg-[var(--danger)]/20 px-2 py-0.5 text-xs font-medium text-[var(--danger-on-tint)] hover:bg-[var(--danger)]/30"
          >
            Delete
          </button>
        ) : (
          <>
            <span className="flex items-center gap-0.5 pointer-coarse:hidden">
              {away ? (
                <button
                  type="button"
                  aria-label={`Move back to inbox: ${title}`}
                  title="Move back to inbox"
                  onClick={backToInbox}
                  className={QUICK}
                >
                  {bucket === 'snoozed' ? (
                    <AlarmClockOff className="size-3.5" />
                  ) : (
                    <Undo2 className="size-3.5" />
                  )}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    aria-label={`Mark done: ${title}`}
                    title={working ? 'Working: stop it first' : 'Mark done'}
                    disabled={working}
                    onClick={done}
                    className={QUICK}
                  >
                    <Check className="size-3.5" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Snooze: ${title}`}
                        title="Snooze"
                        className={QUICK}
                      >
                        <AlarmClock className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      {presets.map((preset) => (
                        <DropdownMenuItem key={preset.id} onSelect={() => snooze(preset.until)}>
                          {preset.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    aria-label={`${bucket === 'pinned' ? 'Unpin' : 'Pin'} conversation: ${title}`}
                    title={bucket === 'pinned' ? 'Unpin' : 'Pin'}
                    onClick={bucket === 'pinned' ? unpin : pin}
                    className={QUICK}
                  >
                    {bucket === 'pinned' ? (
                      <PinOff className="size-3.5" />
                    ) : (
                      <Pin className="size-3.5" />
                    )}
                  </button>
                </>
              )}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`More actions: ${title}`}
                  title="More"
                  className={QUICK}
                >
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {away ? (
                  <DropdownMenuItem onSelect={backToInbox}>
                    <Undo2 />
                    Move back to inbox
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem disabled={working} onSelect={done}>
                      <Check />
                      Mark done
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <AlarmClock />
                        Snooze
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {presets.map((preset) => (
                          <DropdownMenuItem key={preset.id} onSelect={() => snooze(preset.until)}>
                            {preset.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem onSelect={bucket === 'pinned' ? unpin : pin}>
                      {bucket === 'pinned' ? <PinOff /> : <Pin />}
                      {bucket === 'pinned' ? 'Unpin' : 'Pin'}
                    </DropdownMenuItem>
                  </>
                )}
                {bucket !== 'archived' && !working && (
                  <DropdownMenuItem onSelect={() => actions.markUnread(key)}>
                    <CircleDot />
                    Mark unread
                  </DropdownMenuItem>
                )}
                {bucket === 'archived' ? (
                  <DropdownMenuItem onSelect={backToInbox}>
                    <ArchiveRestore />
                    Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled={working} onSelect={archive}>
                    <Archive />
                    Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setConfirming(true)}>
                  <Trash2 />
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}
