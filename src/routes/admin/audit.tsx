import { AdminHeader } from '~/components/admin/admin-layout';
import { Spinner } from '~/components/ui/spinner';
import { type AuditEntry, useAudit, usePeople } from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** One change, in words: "Tim made Bob an administrator". */
export function describeAudit(entry: AuditEntry, names: Map<string, string>): string {
  const actor = entry.actorId ? (names.get(entry.actorId) ?? 'Someone') : 'The system';
  const target = entry.targetId
    ? (names.get(entry.targetId) ?? String(entry.details.email ?? 'someone'))
    : '';
  const details = entry.details as { from?: string; to?: string; email?: string };
  switch (entry.action) {
    case 'person.created':
      return `${target} signed in for the first time`;
    case 'person.initial_admin':
      return `${target} became the first administrator (INITIAL_ADMIN_EMAIL)`;
    case 'person.promoted_cli':
      return `${target} was made an administrator from the server (recovery command)`;
    case 'person.role':
      return details.to === 'admin'
        ? `${actor} made ${target} an administrator`
        : `${actor} made ${target} a member`;
    case 'person.status':
      return details.to === 'suspended'
        ? `${actor} suspended ${target}`
        : `${actor} restored ${target}`;
    case 'person.sessions_ended':
      return entry.actorId === entry.targetId
        ? `${actor} signed out everywhere`
        : `${actor} ended ${target}'s sessions`;
    case 'settings.branding':
      return `${actor} changed the branding`;
    default:
      return `${actor}: ${entry.action}${target ? ` (${target})` : ''}`;
  }
}

export function AdminAuditPage() {
  usePageTitle('Audit log · Admin');
  const audit = useAudit(500);
  const people = usePeople('');
  const names = new Map(people.data?.map((person) => [person.id, person.name || person.email]));
  return (
    <>
      <AdminHeader
        title="Audit log"
        description="Every change to people, roles and settings: who made it and when. The newest 500 are shown."
      />
      {!audit.data ? (
        <div className="py-16">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {audit.data.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm"
            >
              <span className="min-w-0 text-[var(--text-secondary)]">
                {describeAudit(entry, names)}
              </span>
              <time dateTime={entry.at} className="shrink-0 text-xs text-[var(--text-muted)]">
                {when.format(new Date(entry.at))}
              </time>
            </li>
          ))}
          {audit.data.length === 0 && (
            <li className="px-4 py-3 text-sm text-[var(--text-muted)]">Nothing yet.</li>
          )}
        </ul>
      )}
    </>
  );
}
