/**
 * Usage per person, from the platform's usage report for the team
 * (`GET /v1/teams/{team}/usage`). The platform reports per agent; every agent
 * this app manages has a key naming its person (`u:<person>`, `u:<person>:…`),
 * so rows are summed per person. Rows that name no person (agents made by
 * hand in the team, deleted agents, the platform's own) are summed apart.
 */

/** A row of the platform's report (UsageRow), the fields this app reads. */
export interface PlatformUsageRow {
  day?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  managed?: boolean;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedRequests: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Requests to models without prices: not in `costUsd`. */
  unpricedRequests: number;
}

export interface PersonUsage extends UsageTotals {
  personId: string;
  name: string;
  email: string;
  /** How many of their agents were used. */
  agents: number;
}

export interface DayUsage extends UsageTotals {
  day: string;
}

const zero = (): UsageTotals => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedRequests: 0,
});

function add(into: UsageTotals, row: UsageTotals) {
  into.requests += row.requests;
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.costUsd += row.costUsd;
  into.unpricedRequests += row.unpricedRequests;
}

/** The person an agent key names: `u:<person>` or `u:<person>:…`. */
export function personOfKey(key: string | null | undefined): string | null {
  const match = /^u:([^:]+)(?::|$)/.exec(key ?? '');
  return match ? match[1]! : null;
}

export function usageByPerson(
  rows: readonly PlatformUsageRow[],
  keyOfAgent: (agentId: string) => string | undefined,
  personById: (personId: string) => { name: string; email: string } | undefined,
): { people: PersonUsage[]; unassigned: UsageTotals | null; total: UsageTotals } {
  const byPerson = new Map<string, PersonUsage & { agentIds: Set<string> }>();
  const unassigned = zero();
  let anyUnassigned = false;
  const total = zero();
  for (const row of rows) {
    add(total, row);
    const personId = row.agentId ? personOfKey(keyOfAgent(row.agentId)) : null;
    const person = personId ? personById(personId) : undefined;
    if (!personId || !person) {
      add(unassigned, row);
      anyUnassigned = true;
      continue;
    }
    let entry = byPerson.get(personId);
    if (!entry) {
      entry = {
        personId,
        name: person.name,
        email: person.email,
        agents: 0,
        agentIds: new Set(),
        ...zero(),
      };
      byPerson.set(personId, entry);
    }
    add(entry, row);
    entry.agentIds.add(row.agentId!);
    entry.agents = entry.agentIds.size;
  }
  const people = [...byPerson.values()]
    .map(({ agentIds: _ids, ...rest }) => rest)
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
        a.name.localeCompare(b.name),
    );
  return { people, unassigned: anyUnassigned ? unassigned : null, total };
}

/** The report grouped by day, every day of the range present (days without use are zero). */
export function usageByDay(
  rows: readonly PlatformUsageRow[],
  from: string,
  to: string,
): DayUsage[] {
  const byDay = new Map<string, UsageTotals>();
  for (const row of rows) {
    if (!row.day) continue;
    const totals = byDay.get(row.day) ?? zero();
    add(totals, row);
    byDay.set(row.day, totals);
  }
  const out: DayUsage[] = [];
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); ) {
    const key = day.toISOString().slice(0, 10);
    out.push({ day: key, ...(byDay.get(key) ?? zero()) });
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

/** The range for the last `days` days, ending today (UTC), as the platform takes it. */
export function lastDays(days: number, now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}
