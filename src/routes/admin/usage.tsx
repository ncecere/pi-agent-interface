import { useState } from 'react';
import { errorMessage } from '~/api/client';
import { AdminHeader } from '~/components/admin/admin-layout';
import { Spinner } from '~/components/ui/spinner';
import { type UsageTotals, useUsage } from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';

const RANGES = [7, 30, 90] as const;

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const tokensOf = (totals: UsageTotals) => totals.inputTokens + totals.outputTokens;

/** A cost estimate, or a dash when none of it is priced. */
function Cost({ totals }: { totals: UsageTotals }) {
  if (totals.requests > 0 && totals.unpricedRequests === totals.requests)
    return (
      <span
        className="text-[var(--text-muted)]"
        title="Its models have no prices on the platform yet"
      >
        —
      </span>
    );
  return (
    <span
      title={totals.unpricedRequests ? `${totals.unpricedRequests} requests unpriced` : undefined}
    >
      {money.format(totals.costUsd)}
      {totals.unpricedRequests > 0 && <span className="text-[var(--text-muted)]">+</span>}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 p-4 sm:p-5">
      <p className="truncate text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-2 truncate text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

/**
 * Usage per person (the optional `usage` feature): what each person's agents
 * asked of their models, from the platform's usage reports.
 */
export function AdminUsagePage() {
  usePageTitle('Usage · Admin');
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const usage = useUsage(days);
  const data = usage.data;
  const peak = Math.max(1, ...(data?.byDay ?? []).map(tokensOf));
  const unpriced = data ? data.total.unpricedRequests : 0;

  return (
    <>
      <AdminHeader
        title="Usage"
        description="How much each person's agents use their models: requests, tokens and an estimated cost. From the agent platform; days are in UTC."
        actions={
          <fieldset className="flex rounded-lg border border-[var(--border-subtle)] p-0.5">
            <legend className="sr-only">Period</legend>
            {RANGES.map((range) => (
              <button
                key={range}
                type="button"
                aria-pressed={days === range}
                onClick={() => setDays(range)}
                className={cn(
                  'rounded-md px-3 py-1 text-sm transition-colors',
                  days === range
                    ? 'bg-[var(--bg-control)] font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                {range} days
              </button>
            ))}
          </fieldset>
        }
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
          <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] lg:grid-cols-4 [&>*]:border-[var(--border-subtle)] [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t lg:[&>*:nth-child(n+2)]:border-l lg:[&>*:nth-child(n+3)]:border-t-0">
            <Stat label="Requests" value={whole.format(data.total.requests)} />
            <Stat
              label="Tokens"
              value={compact.format(tokensOf(data.total))}
              hint={`${compact.format(data.total.inputTokens)} in · ${compact.format(data.total.outputTokens)} out`}
            />
            <Stat
              label="Estimated cost"
              value={<Cost totals={data.total} />}
              hint={
                unpriced ? `${whole.format(unpriced)} requests to models without prices` : undefined
              }
            />
            <Stat label="People" value={data.people.length} hint="whose agents were used" />
          </div>

          <section aria-labelledby="usage-days">
            <h2 id="usage-days" className="mb-3 text-lg font-semibold">
              Tokens per day
            </h2>
            <div className="flex h-36 items-end gap-px rounded-xl border border-[var(--border-subtle)] px-3 pt-3 pb-2">
              {data.byDay.map((day) => {
                const tokens = tokensOf(day);
                return (
                  <div
                    key={day.day}
                    role="img"
                    aria-label={`${day.day}: ${whole.format(tokens)} tokens, ${whole.format(day.requests)} requests`}
                    title={`${day.day}: ${whole.format(tokens)} tokens · ${whole.format(day.requests)} requests`}
                    className="flex h-full flex-1 items-end"
                  >
                    <div
                      className={cn(
                        'w-full rounded-t-sm',
                        tokens
                          ? 'bg-[var(--accent-bright)]/70 hover:bg-[var(--accent-bright)]'
                          : 'bg-[var(--border-subtle)]',
                      )}
                      style={{ height: tokens ? `${Math.max(3, (tokens / peak) * 100)}%` : '1px' }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-xs text-[var(--text-muted)]">
              <span>{data.from}</span>
              <span>{data.to}</span>
            </div>
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
        </div>
      )}
    </>
  );
}
