import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '~/api/client';
import { SettingsSection } from '~/components/settings/settings-layout';
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
import type { UsageTotals } from '~/hooks/use-admin';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';

interface MyUsage {
  from: string;
  to: string;
  days: number;
  agents: Array<UsageTotals & { agentId: string; name: string }>;
  total: UsageTotals;
  byDay: Array<UsageTotals & { day: string }>;
}

/**
 * The person's own usage (the optional `myUsage` feature): what their agents
 * asked of their models. Theirs only.
 */
export function SettingsUsagePage() {
  usePageTitle('Usage · Settings');
  const [days, setDays] = useState<UsageRange>(30);
  const usage = useQuery({
    queryKey: ['me', 'usage', days],
    queryFn: () => api.get<MyUsage>(`/api/me/usage?days=${days}`),
    placeholderData: (previous) => previous,
  });
  const data = usage.data;

  return (
    <SettingsSection title="Usage" first>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-[var(--text-muted)]">
          How much your agents use their models: requests, tokens and an estimated cost. Only you
          and your administrators see this. Days are in UTC.
        </p>
        <RangePicker value={days} onChange={setDays} />
      </div>
      {usage.isError ? (
        <p
          role="alert"
          className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
        >
          Your usage could not be read: {errorMessage(usage.error)}
        </p>
      ) : !data ? (
        <div className="py-12">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <div className={cn('space-y-8', usage.isPlaceholderData && 'opacity-60')}>
          <StatStrip>
            <TotalsStats total={data.total} />
            <Stat label="Agents" value={data.agents.length} hint="used in this period" />
          </StatStrip>
          <section aria-labelledby="my-usage-days">
            <h3 id="my-usage-days" className="mb-3 text-base font-semibold">
              Tokens per day
            </h3>
            <DailyBars days={data.byDay} from={data.from} to={data.to} />
          </section>
          <section aria-labelledby="my-usage-agents">
            <h3 id="my-usage-agents" className="mb-3 text-base font-semibold">
              By agent
            </h3>
            {data.agents.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                Your agents haven't been used in these {days} days.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                    <tr className="border-b border-[var(--border-subtle)]">
                      <th className="px-4 py-2.5 font-medium">Agent</th>
                      <th className="px-4 py-2.5 text-right font-medium">Requests</th>
                      <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
                      <th className="px-4 py-2.5 text-right font-medium">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)] tabular-nums">
                    {data.agents.map((agent) => (
                      <tr key={agent.agentId}>
                        <td className="px-4 py-2.5 font-medium">{agent.name}</td>
                        <td className="px-4 py-2.5 text-right">{whole.format(agent.requests)}</td>
                        <td className="px-4 py-2.5 text-right">
                          {compact.format(agent.inputTokens + agent.outputTokens)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Cost totals={agent} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </SettingsSection>
  );
}
