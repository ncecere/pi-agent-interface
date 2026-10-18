// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { waitForDatabase } from '../../server/store-pg.ts';

/** A stand-in for the `postgres` tagged-template client: each call answers or fails as scripted. */
const database = (script: Array<'ok' | { code: string } | { errors: Array<{ code: string }> }>) => {
  let calls = 0;
  const sql = (async () => {
    const step = script[Math.min(calls++, script.length - 1)];
    if (step === 'ok') return [{ '?column?': 1 }];
    throw Object.assign(new Error('connect failed'), step);
  }) as unknown as Parameters<typeof waitForDatabase>[0];
  return { sql, calls: () => calls };
};

const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

describe('waitForDatabase', () => {
  it('returns at once when the database answers', async () => {
    const db = database(['ok']);
    await waitForDatabase(db.sql, { ...clock(), log: () => undefined });
    expect(db.calls()).toBe(1);
  });

  it('waits out a database that is not up yet, and says so once', async () => {
    const db = database([
      { code: 'ECONNREFUSED' },
      { code: 'EHOSTUNREACH' },
      { code: '57P03' },
      'ok',
    ]);
    const said: string[] = [];
    await waitForDatabase(db.sql, { ...clock(), log: (m) => said.push(m) });
    expect(db.calls()).toBe(4);
    expect(said[0]).toContain('waiting for the database');
    expect(said.filter((m) => m.includes('waiting'))).toHaveLength(1);
    expect(said.at(-1)).toContain('answered');
  });

  it('treats an address that fails several ways as not up yet', async () => {
    const db = database([{ errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] }, 'ok']);
    await waitForDatabase(db.sql, { ...clock(), log: () => undefined });
    expect(db.calls()).toBe(2);
  });

  it('fails at once on a wrong password or a missing database, with the database’s own error', async () => {
    for (const code of ['28P01', '3D000']) {
      const db = database([{ code }]);
      await expect(
        waitForDatabase(db.sql, { ...clock(), log: () => undefined }),
      ).rejects.toMatchObject({ code });
      expect(db.calls()).toBe(1);
    }
  });

  it('gives up after the timeout, saying how long it waited', async () => {
    const db = database([{ code: 'ECONNREFUSED' }]);
    await expect(
      waitForDatabase(db.sql, { ...clock(), timeoutMs: 20_000, log: () => undefined }),
    ).rejects.toThrow('did not answer within 20s');
  });
});
