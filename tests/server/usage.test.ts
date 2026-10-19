// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseFeatureChange, resolveFeatures } from '../../server/features.ts';
import {
  connectedUsage,
  lastDays,
  personOfKey,
  sumUsage,
  usageByAgent,
  usageByDay,
  usageByPerson,
} from '../../server/usage.ts';

const row = (agentId: string | null, requests: number, tokens = 100, day?: string) => ({
  agentId,
  day,
  requests,
  inputTokens: tokens,
  outputTokens: tokens * 2,
  costUsd: requests * 0.01,
  unpricedRequests: 0,
});

describe('features', () => {
  it('uses the default until an administrator chooses, and the environment can lock one off', () => {
    expect(resolveFeatures(null)).toEqual({ usage: true, connectedUsage: false, myUsage: false });
    expect(resolveFeatures({ usage: false, myUsage: true })).toEqual({
      usage: false,
      connectedUsage: false,
      myUsage: true,
    });
    expect(resolveFeatures({ usage: true }, ['usage'])).toMatchObject({ usage: false });
    expect(resolveFeatures({ usage: 'yes' })).toMatchObject({ usage: true }); // not a boolean: the default
  });

  it('accepts known features as booleans, and refuses turning a locked one on', () => {
    expect(parseFeatureChange({ usage: false })).toEqual({ value: { usage: false } });
    expect(parseFeatureChange({ nope: true })).toHaveProperty('problems.nope');
    expect(parseFeatureChange({ usage: 'on' })).toHaveProperty('problems.usage');
    expect(parseFeatureChange({ usage: true }, ['usage'])).toHaveProperty('problems.usage');
    expect(parseFeatureChange({ usage: false }, ['usage'])).toEqual({ value: { usage: false } });
    expect(parseFeatureChange([])).toHaveProperty('problems.body');
  });
});

describe('usage', () => {
  it('reads the person from an agent key', () => {
    expect(personOfKey('u:abc')).toBe('abc');
    expect(personOfKey('u:abc:p:2')).toBe('abc');
    expect(personOfKey('other')).toBeNull();
    expect(personOfKey(undefined)).toBeNull();
  });

  it('sums each person’s agents, and keeps what names nobody apart', () => {
    const keys: Record<string, string> = { a1: 'u:tim', a2: 'u:tim:p:1', b1: 'u:bob', z: 'u:gone' };
    const people: Record<string, { name: string; email: string }> = {
      tim: { name: 'Tim', email: 't@x' },
      bob: { name: 'Bob', email: 'b@x' },
    };
    const out = usageByPerson(
      [row('a1', 5), row('a2', 1, 1000), row('b1', 2), row('z', 1), row(null, 3)],
      (id) => keys[id],
      (id) => people[id],
    );
    expect(out.people.map((p) => [p.name, p.requests, p.agents])).toEqual([
      ['Tim', 6, 2],
      ['Bob', 2, 1],
    ]);
    expect(out.unassigned?.requests).toBe(4); // a person no longer here, and the team's own agents
    expect(out.total.requests).toBe(12);
  });

  it('has no unassigned row when every agent names a person', () => {
    expect(
      usageByPerson(
        [row('a1', 1)],
        () => 'u:tim',
        () => ({ name: 'Tim', email: '' }),
      ).unassigned,
    ).toBeNull();
  });

  it('lists every day of the range, with the days nobody used as zero', () => {
    const days = usageByDay(
      [row(null, 2, 10, '2026-10-02'), row(null, 1, 10, '2026-10-02')],
      '2026-10-01',
      '2026-10-03',
    );
    expect(days.map((d) => [d.day, d.requests])).toEqual([
      ['2026-10-01', 0],
      ['2026-10-02', 3],
      ['2026-10-03', 0],
    ]);
  });

  it('counts the last N days including today', () => {
    expect(lastDays(7, new Date('2026-10-18T12:00:00Z'))).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
  });
});

describe('usage by agent', () => {
  it('sums each agent, names it as the person knows it, most used first', () => {
    const out = usageByAgent(
      [row('a', 1, 10), row('b', 1, 500), row('a', 2, 10), row(null, 9)],
      (id) => `Agent ${id}`,
    );
    expect(out.map((agent) => [agent.name, agent.requests])).toEqual([
      ['Agent b', 1],
      ['Agent a', 3],
    ]);
    expect(sumUsage(out).requests).toBe(4);
  });
});

describe('connectedUsage (Connect mode, person by person)', () => {
  const range = { from: '2026-10-01', to: '2026-10-03' };
  const row = (agentId: string, requests: number) => ({
    agentId,
    requests,
    inputTokens: requests * 100,
    outputTokens: requests * 10,
    costUsd: requests / 100,
    unpricedRequests: 0,
  });
  const ref = (n: string) => ({ id: n, name: n.toUpperCase(), email: `${n}@example.test` });
  const describeError = (error: unknown) => (error as Error).message;

  it('sums connected people, ranks them by tokens, and lists who is not covered apart', async () => {
    const reports: Record<string, ReturnType<typeof report> | null> = {};
    const report = (agents: [string, number][], dayRequests: number) => ({
      byAgent: agents.map(([id, n]) => row(id, n)),
      byDay: [{ day: '2026-10-02', ...row('x', dayRequests) }],
    });
    reports.ann = report(
      [
        ['a1', 5],
        ['a2', 5],
      ],
      10,
    );
    reports.ben = report([['b1', 50]], 50);
    reports.cy = null; // not connected
    reports.dee = report([], 0); // connected, used nothing
    const out = await connectedUsage(
      ['ann', 'ben', 'cy', 'dee'].map(ref),
      async (person) => reports[person.id] ?? null,
      range,
      describeError,
    );
    expect(out.people.map((p) => [p.personId, p.requests, p.agents])).toEqual([
      ['ben', 50, 1],
      ['ann', 10, 2],
    ]);
    expect(out.notConnected).toEqual([{ name: 'CY', email: 'cy@example.test' }]);
    expect(out.unavailable).toEqual([]);
    expect(out.total.requests).toBe(60);
    expect(out.total.inputTokens).toBe(6000);
    expect(out.byDay).toHaveLength(3);
    expect(out.byDay.find((d) => d.day === '2026-10-02')?.requests).toBe(60);
    expect(out.byDay.find((d) => d.day === '2026-10-01')?.requests).toBe(0);
  });

  it('keeps going when one person cannot be read, and says why', async () => {
    const out = await connectedUsage(
      ['ann', 'ben', 'cy'].map(ref),
      async (person) => {
        if (person.id === 'ben') throw new Error('The platform answered 503.');
        return { byAgent: [row('a', 3)], byDay: [] };
      },
      range,
      describeError,
    );
    expect(out.people.map((p) => p.personId).sort()).toEqual(['ann', 'cy']);
    expect(out.unavailable).toEqual([
      { name: 'BEN', email: 'ben@example.test', reason: 'The platform answered 503.' },
    ]);
    expect(out.total.requests).toBe(6);
  });

  it('reads at most a few at a time', async () => {
    let running = 0;
    let most = 0;
    const out = await connectedUsage(
      Array.from({ length: 23 }, (_, i) => ref(`p${i}`)),
      async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        return { byAgent: [row('a', 1)], byDay: [] };
      },
      range,
      describeError,
      4,
    );
    expect(out.people).toHaveLength(23);
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
  });

  it('has nothing to report for nobody', async () => {
    const out = await connectedUsage([], async () => null, range, describeError);
    expect(out.people).toEqual([]);
    expect(out.total.requests).toBe(0);
    expect(out.byDay).toHaveLength(3);
  });
});
