import { Link } from '@tanstack/react-router';
import { AdminHeader, timeAgo } from '~/components/admin/admin-layout';
import { Spinner } from '~/components/ui/spinner';
import { useAudit, useOverview, usePeople } from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';
import { describeAudit } from '~/routes/admin/audit';

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="min-w-0 p-4 sm:p-5">
      <p className="truncate text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-2 truncate text-xl font-semibold sm:text-2xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

export function AdminOverviewPage() {
  usePageTitle('Overview · Admin');
  const overview = useOverview();
  const audit = useAudit(8);
  const people = usePeople('');
  const names = new Map(people.data?.map((person) => [person.id, person.name || person.email]));
  const data = overview.data;

  return (
    <>
      <AdminHeader
        title="Overview"
        description="Who uses this instance, and what has changed lately."
      />
      {!data ? (
        <div className="py-16">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] lg:grid-cols-4 [&>*]:border-[var(--border-subtle)] [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t lg:[&>*:nth-child(n+2)]:border-l lg:[&>*:nth-child(n+3)]:border-t-0">
          <Stat
            label="People"
            value={data.people}
            hint={`${data.newThisMonth} new in the last 30 days`}
          />
          <Stat
            label="Active today"
            value={data.activeToday}
            hint={`${data.activeThisWeek} this week`}
          />
          <Stat label="Administrators" value={data.admins} />
          <Stat label="Suspended" value={data.suspended} />
        </div>
      )}

      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent changes</h2>
          <Link to="/admin/audit" className="text-sm text-[var(--accent-bright)] hover:underline">
            Audit log
          </Link>
        </div>
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {(audit.data ?? []).map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm"
            >
              <span className="min-w-0 text-[var(--text-secondary)]">
                {describeAudit(entry, names)}
              </span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">{timeAgo(entry.at)}</span>
            </li>
          ))}
          {audit.data?.length === 0 && (
            <li className="px-4 py-3 text-sm text-[var(--text-muted)]">Nothing yet.</li>
          )}
        </ul>
      </section>
    </>
  );
}
