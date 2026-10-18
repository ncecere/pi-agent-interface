import { RefreshCw } from 'lucide-react';
import { Button } from '~/components/ui/button';

/** A stored reason as a sentence; the server's own reasons have no full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Under a reply that failed (#133): that it failed and why, in the reply's
 * place, live and after a reload, with Retry beside it rather than only in
 * the hover toolbar. Before, a failed reply with no text was an empty space
 * under the question, as if the model had answered with nothing.
 *
 * The latest reply's note is an alert, so the failure is announced where it
 * is shown; the conversation no longer adds a second, reasonless notice.
 */
export function ReplyFailureNote({
  reason,
  onRetry,
  latest,
}: {
  reason: string;
  onRetry?: () => void;
  latest: boolean;
}) {
  return (
    <div
      role={latest ? 'alert' : 'note'}
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-[var(--danger)]/15 px-4 py-2.5 text-sm text-[var(--danger-on-tint)]"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium">This reply failed.</span> {sentence(reason)}
      </p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * Under the person's last message when the agent is idle and never answered
 * it: the platform can drop a turn without writing a reply or an error. Said,
 * so the question does not hang there as if an answer were on its way.
 */
export function NoReplyNote({ agentName, onRetry }: { agentName: string; onRetry?: () => void }) {
  return (
    <div
      role="note"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-[var(--warning)]/12 px-4 py-2.5 text-sm text-[var(--text-secondary)]"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium text-[var(--text-primary)]">No reply.</span> {agentName}{' '}
        stopped without answering your last message.
      </p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}
