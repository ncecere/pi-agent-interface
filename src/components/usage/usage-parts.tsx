import type { ReactNode } from 'react';
import type { UsageTotals } from '~/hooks/use-admin';
import { cn } from '~/lib/utils';

/** The pieces Admin → Usage and Settings → Usage share. */

export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
export const whole = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

export const tokensOf = (totals: UsageTotals) => totals.inputTokens + totals.outputTokens;

/** A cost estimate, or a dash when none of it is priced. */
export function Cost({ totals }: { totals: UsageTotals }) {
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

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
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

/** Up to four stats in a bordered strip; two columns on narrow screens. */
export function StatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] lg:grid-cols-4 [&>*]:border-[var(--border-subtle)] [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t lg:[&>*:nth-child(n+2)]:border-l lg:[&>*:nth-child(n+3)]:border-t-0">
      {children}
    </div>
  );
}

/** The three totals every usage page opens with: requests, tokens, cost. */
export function TotalsStats({ total }: { total: UsageTotals }) {
  return (
    <>
      <Stat label="Requests" value={whole.format(total.requests)} />
      <Stat
        label="Tokens"
        value={compact.format(tokensOf(total))}
        hint={`${compact.format(total.inputTokens)} in · ${compact.format(total.outputTokens)} out`}
      />
      <Stat
        label="Estimated cost"
        value={<Cost totals={total} />}
        hint={
          total.unpricedRequests
            ? `${whole.format(total.unpricedRequests)} requests to models without prices`
            : undefined
        }
      />
    </>
  );
}

export function RangePicker({
  value,
  onChange,
}: {
  value: UsageRange;
  onChange: (range: UsageRange) => void;
}) {
  return (
    <fieldset className="flex rounded-lg border border-[var(--border-subtle)] p-0.5">
      <legend className="sr-only">Period</legend>
      {USAGE_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={value === range}
          onClick={() => onChange(range)}
          className={cn(
            'rounded-md px-3 py-1 text-sm transition-colors',
            value === range
              ? 'bg-[var(--bg-control)] font-medium text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
          )}
        >
          {range} days
        </button>
      ))}
    </fieldset>
  );
}

/** Tokens per day as bars, the busiest day full height. */
export function DailyBars({
  days,
  from,
  to,
}: {
  days: Array<UsageTotals & { day: string }>;
  from: string;
  to: string;
}) {
  const peak = Math.max(1, ...days.map(tokensOf));
  return (
    <>
      <div className="flex h-36 items-end gap-px rounded-xl border border-[var(--border-subtle)] px-3 pt-3 pb-2">
        {days.map((day) => {
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
        <span>{from}</span>
        <span>{to}</span>
      </div>
    </>
  );
}
