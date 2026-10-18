// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseFeatureChange, resolveFeatures } from '../../server/features.ts';
import { lastDays, personOfKey, usageByDay, usageByPerson } from '../../server/usage.ts';

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
    expect(resolveFeatures(null)).toEqual({ usage: true });
    expect(resolveFeatures({ usage: false })).toEqual({ usage: false });
    expect(resolveFeatures({ usage: true }, ['usage'])).toEqual({ usage: false });
    expect(resolveFeatures({ usage: 'yes' })).toEqual({ usage: true }); // not a boolean: the default
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
