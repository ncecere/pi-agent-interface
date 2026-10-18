import { Link } from '@tanstack/react-router';
import { ArchiveRestore, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteThread } from '~/hooks/use-agents';
import { useInbox, useInboxActions } from '~/hooks/use-inbox';
import { usePageTitle } from '~/lib/document-title';
import type { InboxEntry } from '~/lib/inbox';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * Conversations put away (archived) or finished with (done): brought back, or
 * deleted for good, one by one or together.
 */
function Group({
  title,
  empty,
  entries,
  agentName,
  dateOf,
  restoreLabel,
  onRestore,
}: {
  title: string;
  empty: string;
  entries: InboxEntry[];
  agentName: (id: string) => string | undefined;
  dateOf: (entry: InboxEntry) => number | undefined;
  restoreLabel: string;
  onRestore: (entry: InboxEntry) => void;
}) {
  const remove = useDeleteThread();
  const actions = useInboxActions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<InboxEntry[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const chosen = entries.filter((entry) => selected.has(entry.key));
  const all = entries.length > 0 && chosen.length === entries.length;
  const multipleAgents = new Set(entries.map((entry) => entry.agentId)).size > 1;

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const deleteNow = async (doomed: InboxEntry[]) => {
    setDeleting(true);
    try {
      await Promise.all(
        doomed.map(async (entry) => {
          await remove.mutateAsync({ agentId: entry.agentId, threadId: entry.threadId });
          actions.restore(entry.key, undefined);
        }),
      );
      setSelected(new Set());
      setConfirming(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SettingsSection title={title} first={title === 'Archived'}>
      {entries.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{empty}</p>
      ) : (
        <div className="rounded-2xl border border-[var(--border-subtle)]">
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5">
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={all}
                ref={(box) => {
                  if (box) box.indeterminate = chosen.length > 0 && !all;
                }}
                onChange={() =>
                  setSelected(all ? new Set() : new Set(entries.map((entry) => entry.key)))
                }
                className="size-4 accent-[var(--accent)]"
              />
              {chosen.length > 0 ? `${chosen.length} selected` : `Select all (${entries.length})`}
            </label>
            {chosen.length > 0 && (
              <div className="ml-auto flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    for (const entry of chosen) onRestore(entry);
                    setSelected(new Set());
                  }}
                >
                  <Undo2 />
                  {restoreLabel}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirming(chosen)}>
                  <Trash2 />
                  Delete
                </Button>
              </div>
            )}
          </div>
          <ul>
            {entries.map((entry) => {
              const date = dateOf(entry);
              return (
                <li
                  key={entry.key}
                  className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5 last:border-b-0"
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${entry.title}`}
                    checked={selected.has(entry.key)}
                    onChange={() => toggle(entry.key)}
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <Link
                      to="/agents/$agentId/threads/$threadId"
                      params={{ agentId: entry.agentId, threadId: entry.threadId }}
                      className="block truncate text-sm text-[var(--text-primary)] hover:underline"
                    >
                      {entry.title}
                    </Link>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      {[
                        multipleAgents ? agentName(entry.agentId) : null,
                        date ? when.format(date) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${restoreLabel}: ${entry.title}`}
                    title={restoreLabel}
                    onClick={() => onRestore(entry)}
                  >
                    <ArchiveRestore />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete: ${entry.title}`}
                    title="Delete"
                    onClick={() => setConfirming([entry])}
                  >
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirming?.length === 1
                ? 'Delete this conversation?'
                : `Delete ${confirming?.length ?? 0} conversations?`}
            </DialogTitle>
            <DialogDescription>
              {confirming?.length === 1 ? `“${confirming[0]?.title}” is` : 'They are'} deleted from
              the agent for good. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={deleting}
              onClick={() => confirming && void deleteNow(confirming)}
            >
              {deleting ? <Spinner className="size-4" /> : <Trash2 />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

export function SettingsConversationsPage() {
  usePageTitle('Conversations · Settings');
  const inbox = useInbox();
  const actions = useInboxActions();
  const names = new Map(inbox.agents.map((agent) => [agent.id, agent.name]));
  const agentName = (id: string) => names.get(id);

  if (inbox.loading)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );

  return (
    <>
      <Group
        title="Archived"
        empty="Nothing archived. Archive a conversation from its menu in the sidebar to put it away here."
        entries={inbox.sections.archived}
        agentName={agentName}
        dateOf={(entry) => entry.meta.archivedAt}
        restoreLabel="Restore"
        onRestore={(entry) => actions.unarchive(entry.key)}
      />
      <Group
        title="Settled"
        empty="Nothing settled. Settle a conversation from the sidebar when you're finished with it."
        entries={inbox.sections.done}
        agentName={agentName}
        dateOf={(entry) => entry.meta.settledAt}
        restoreLabel="Move to inbox"
        onRestore={(entry) => actions.unsettle(entry.key)}
      />
    </>
  );
}
