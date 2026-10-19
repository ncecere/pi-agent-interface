import { useState } from 'react';
import { errorMessage } from '~/api/client';
import { AdminHeader } from '~/components/admin/admin-layout';
import { Spinner } from '~/components/ui/spinner';
import {
  Cost,
  compact,
  DailyBars,
  RangePicker,
  Stat,
  StatStrip,
  TotalsStats,
  type UsageRange,
  whole,
} from '~/components/usage/usage-parts';
import { useUsage } from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';

/**
 * Usage per person (the optional `usage` feature): what each person's agents
 * asked of their models, from the platform's usage reports.
 */
export function AdminUsagePage() {
  usePageTitle('Usage · Admin');
  const [days, setDays] = useState<UsageRange>(30);
  const usage = useUsage(days);
  const data = usage.data;

  return (
    <>
      <AdminHeader
        title="Usage"
        description={
          data?.scope === 'connected'
            ? "How much each connected person's own agents use their models: requests, tokens and an estimated cost, read from their personal workspace on the platform. Agents of their teams are not counted. Days are in UTC."
            : "How much each person's agents use their models: requests, tokens and an estimated cost. From the agent platform; days are in UTC."
        }
        actions={<RangePicker value={days} onChange={setDays} />}
      />

      {usage.isError ? (
        <p
          role="alert"
          className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
        >
          The usage report could not be read: {errorMessage(usage.error)}
        </p>
      ) : !data ? (
        <div className="py-16">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <div className={cn('space-y-10', usage.isPlaceholderData && 'opacity-60')}>
          <StatStrip>
            <TotalsStats total={data.total} />
            <Stat label="People" value={data.people.length} hint="whose agents were used" />
            {data.scope === 'connected' && (
              <Stat
                label="Not covered"
                value={(data.notConnected?.length ?? 0) + (data.unavailable?.length ?? 0)}
                hint="not connected, or not reachable"
              />
            )}
          </StatStrip>

          <section aria-labelledby="usage-days">
            <h2 id="usage-days" className="mb-3 text-lg font-semibold">
              Tokens per day
            </h2>
            <DailyBars days={data.byDay} from={data.from} to={data.to} />
          </section>

          <section aria-labelledby="usage-people">
            <h2 id="usage-people" className="mb-3 text-lg font-semibold">
              By person
            </h2>
            <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="px-4 py-2.5 font-medium">Person</th>
                    <th className="px-4 py-2.5 text-right font-medium">Agents</th>
                    <th className="px-4 py-2.5 text-right font-medium">Requests</th>
                    <th className="px-4 py-2.5 text-right font-medium">Tokens in</th>
                    <th className="px-4 py-2.5 text-right font-medium">Tokens out</th>
                    <th className="px-4 py-2.5 text-right font-medium">Est. cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)] tabular-nums">
                  {data.people.map((person) => (
                    <tr key={person.personId}>
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{person.name || person.email}</span>
                        <span className="block text-xs text-[var(--text-muted)]">
                          {person.email}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">{person.agents}</td>
                      <td className="px-4 py-2.5 text-right">{whole.format(person.requests)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {compact.format(person.inputTokens)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {compact.format(person.outputTokens)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Cost totals={person} />
                      </td>
                    </tr>
                  ))}
                  {data.unassigned && (
                    <tr className="text-[var(--text-muted)]">
                      <td className="px-4 py-2.5">
                        Other agents
                        <span className="block text-xs">
                          Made in the team by hand, deleted, or a person no longer here
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">—</td>
                      <td className="px-4 py-2.5 text-right">
                        {whole.format(data.unassigned.requests)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {compact.format(data.unassigned.inputTokens)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {compact.format(data.unassigned.outputTokens)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Cost totals={data.unassigned} />
                      </td>
                    </tr>
                  )}
                  {data.people.length === 0 && !data.unassigned && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-[var(--text-muted)]">
                        No use in these {days} days.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {data.scope === 'connected' &&
            ((data.unavailable?.length ?? 0) > 0 || (data.notConnected?.length ?? 0) > 0) && (
              <section aria-labelledby="usage-coverage">
                <h2 id="usage-coverage" className="mb-1 text-lg font-semibold">
                  Not in these figures
                </h2>
                <p className="mb-3 text-sm text-[var(--text-muted)]">
                  Their use is unknown here, which is not the same as none.
                </p>
                <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] text-sm">
                  {data.unavailable?.map((person) => (
                    <li key={`u-${person.email}`} className="flex flex-wrap gap-x-3 px-4 py-2.5">
                      <span className="font-medium">{person.name || person.email}</span>
                      <span className="text-[var(--text-muted)]">{person.email}</span>
                      <span className="ml-auto text-[var(--danger-on-tint)]">
                        Could not be read: {person.reason}
                      </span>
                    </li>
                  ))}
                  {data.notConnected?.map((person) => (
                    <li key={`n-${person.email}`} className="flex flex-wrap gap-x-3 px-4 py-2.5">
                      <span className="font-medium">{person.name || person.email}</span>
                      <span className="text-[var(--text-muted)]">{person.email}</span>
                      <span className="ml-auto text-[var(--text-muted)]">Has not connected</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
        </div>
      )}
    </>
  );
}
