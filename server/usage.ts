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

/** Totals of some rows. */
export function sumUsage(rows: readonly UsageTotals[]): UsageTotals {
  const total = zero();
  for (const row of rows) add(total, row);
  return total;
}

export interface AgentUsage extends UsageTotals {
  agentId: string;
  name: string;
}

/** One person's agents: their rows summed per agent, named as the person knows them, most used first. */
export function usageByAgent(
  rows: readonly PlatformUsageRow[],
  nameOf: (agentId: string) => string,
): AgentUsage[] {
  const byAgent = new Map<string, AgentUsage>();
  for (const row of rows) {
    if (!row.agentId) continue;
    const entry = byAgent.get(row.agentId) ?? {
      agentId: row.agentId,
      name: nameOf(row.agentId),
      ...zero(),
    };
    add(entry, row);
    byAgent.set(row.agentId, entry);
  }
  return [...byAgent.values()].sort(
    (a, b) =>
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.name.localeCompare(b.name),
  );
}

// ── Connect mode: usage read person by person ────────────────────────────────────────────────

export interface PersonRef {
  id: string;
  name: string;
  email: string;
}

export interface ConnectedUsage {
  people: PersonUsage[];
  /** Have no connection to the platform: their use is unknown here, not zero. */
  notConnected: Array<{ name: string; email: string }>;
  /** Connected, but the platform did not report (it was down, or the connection ended just now). */
  unavailable: Array<{ name: string; email: string; reason: string }>;
  total: UsageTotals;
  byDay: DayUsage[];
}

/** What reading one person's usage returns: the report by agent and by day, or null when they have not connected. */
export type PersonReport = { byAgent: PlatformUsageRow[]; byDay: PlatformUsageRow[] } | null;

/**
 * Usage across people who connected their own platform accounts (Connect mode): each person's own report, read
 * with their own connection (`read`), a few at a time. A person with no connection is listed as such and a person
 * whose report could not be read is listed with why: neither is counted as zero, and one failing never loses the others.
 */
export async function connectedUsage(
  people: readonly PersonRef[],
  read: (person: PersonRef) => Promise<PersonReport>,
  range: { from: string; to: string },
  describe: (error: unknown) => string,
  concurrency = 5,
): Promise<ConnectedUsage> {
  const results = new Array<
    | { kind: 'ok'; report: NonNullable<PersonReport> }
    | { kind: 'none' }
    | { kind: 'failed'; reason: string }
  >(people.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const person = people[index];
      if (!person) return;
      try {
        const report = await read(person);
        results[index] = report ? { kind: 'ok', report } : { kind: 'none' };
      } catch (error) {
        results[index] = { kind: 'failed', reason: describe(error) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, people.length) }, worker));

  const out: ConnectedUsage = {
    people: [],
    notConnected: [],
    unavailable: [],
    total: zero(),
    byDay: [],
  };
  const dayRows: PlatformUsageRow[] = [];
  people.forEach((person, index) => {
    const result = results[index];
    if (!result || result.kind === 'none') {
      out.notConnected.push({ name: person.name, email: person.email });
    } else if (result.kind === 'failed') {
      out.unavailable.push({ name: person.name, email: person.email, reason: result.reason });
    } else {
      const rows = result.report.byAgent.filter((row) => row.agentId);
      const totals = sumUsage(rows);
      add(out.total, totals);
      dayRows.push(...result.report.byDay);
      // Someone connected who used nothing is not a row of zeros: they have nothing to report.
      if (rows.length > 0)
        out.people.push({
          personId: person.id,
          name: person.name,
          email: person.email,
          agents: new Set(rows.map((row) => row.agentId)).size,
          ...totals,
        });
    }
  });
  out.people.sort(
    (a, b) =>
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.name.localeCompare(b.name),
  );
  out.byDay = usageByDay(dayRows, range.from, range.to);
  return out;
}
