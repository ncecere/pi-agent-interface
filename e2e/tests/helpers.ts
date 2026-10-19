import type { Page } from '@playwright/test';

/** Signs in as a development account (the fictional people of e2e/platform/world.mjs), as the sign-in button does. */
export async function signInAs(page: Page, account: string) {
  await page.goto('/sign-in');
  const status = await page.evaluate(async (id) => {
    const response = await fetch('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: id }),
    });
    return response.status;
  }, account);
  if (status !== 200) throw new Error(`could not sign in as ${account}: ${status}`);
}

import type { Locator } from '@playwright/test';

/** What is drawn: an element's opacity times its ancestors' (Playwright counts a transparent element as visible). */
export function drawnOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let at: Element | null = element; at; at = at.parentElement)
      opacity *= Number(getComputedStyle(at).opacity);
    return opacity;
  });
}

/** True when two elements' boxes share any area. */
export async function overlap(a: Locator, b: Locator): Promise<boolean> {
  const [one, two] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!one || !two) return false;
  return (
    one.x < two.x + two.width &&
    two.x < one.x + one.width &&
    one.y < two.y + two.height &&
    two.y < one.y + one.height
  );
}

const FAKE = 'http://127.0.0.1:8299';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Writes a person's saved inbox state as their own use would have left it, from the flags the fake platform's canned
 * conversations carry (a pinned one, a settled one, what has been read). What the platform itself says (busy,
 * finished, failed) is not written here: the app derives Working, Done and Failed from it.
 */
export async function seedInbox(
  page: Page,
  email: string,
  world: 'service' | 'connect' = 'service',
) {
  const reply = await (
    await fetch(`${FAKE}/__demo/inbox?email=${encodeURIComponent(email)}&world=${world}`)
  ).json();
  const { anchor, threads } = reply.data as {
    anchor: number;
    threads: {
      agentId: string;
      threadId: string;
      updatedAt: number;
      lastReplyAt: number | null;
      lastError: unknown;
      flags: {
        noReply?: boolean;
        unread?: boolean;
        busy?: boolean;
        pinned?: boolean;
        settledAgo?: number | null;
        archivedAgo?: number | null;
        snoozed?: { untilIn: number; atAgo: number } | null;
        woke?: boolean;
      };
    }[];
  };
  const metas: Record<string, Record<string, number>> = {};
  for (const t of threads) {
    const f = t.flags;
    const meta: Record<string, number> = { _at: anchor };
    if (f.noReply) meta.completedAt = meta.failedAt = t.updatedAt + 95_000;
    else if (t.lastReplyAt != null && !t.lastError && !f.unread && !f.busy)
      meta.visitedAt = Math.min(t.lastReplyAt + 2 * MIN, anchor);
    if (f.busy) meta.workingSince = t.updatedAt;
    if (f.pinned) meta.pinnedAt = anchor - 2 * DAY;
    if (f.settledAgo != null) meta.settledAt = anchor - f.settledAgo;
    if (f.archivedAgo != null) meta.archivedAt = anchor - f.archivedAgo;
    if (f.snoozed) {
      meta.snoozedUntil = anchor + f.snoozed.untilIn;
      meta.snoozedAt = anchor - f.snoozed.atAgo;
    }
    if (f.woke) {
      meta.snoozedUntil = anchor - 20 * MIN;
      meta.snoozedAt = anchor - 3 * HOUR;
    }
    if (Object.keys(meta).length > 1) metas[`${t.agentId}/${t.threadId}`] = meta;
  }
  const me = await (await page.request.get('/api/me')).json();
  const done = await page.request.put('/api/me/prefs/inbox', {
    headers: { 'X-CSRF-Token': me.data.csrfToken },
    data: { value: { v: 1, threads: metas, since: anchor - 30 * DAY } },
  });
  if (!done.ok()) throw new Error(`could not save the inbox: ${done.status()}`);
}

/** Saves the person's appearance (what Settings › Customization saves), so the app opens in that theme. */
export async function setTheme(page: Page, theme: 'light' | 'dark') {
  const me = await (await page.request.get('/api/me')).json();
  const done = await page.request.put('/api/me/prefs/appearance', {
    headers: { 'X-CSRF-Token': me.data.csrfToken },
    data: { value: { theme } },
  });
  if (!done.ok()) throw new Error(`could not save the appearance: ${done.status()}`);
}

/** Gives a person's agent many conversations (the fake platform's /__demo/bulk), as a long-time user would have. */
export async function addConversations(page: Page, email: string, count: number) {
  const agents = await (await page.request.get('/api/agents')).json();
  const agentId = agents.data[0].id as string;
  const done = await fetch(`${FAKE}/__demo/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, count, agentId }),
  });
  if (!done.ok) throw new Error(`could not add conversations: ${done.status}`);
  return agentId;
}

/** Writes the person's saved inbox from thread keys: `{ [agentId/threadId]: meta }`. */
export async function saveInbox(page: Page, threads: Record<string, Record<string, number>>) {
  const me = await (await page.request.get('/api/me')).json();
  const done = await page.request.put('/api/me/prefs/inbox', {
    headers: { 'X-CSRF-Token': me.data.csrfToken },
    data: { value: { v: 1, threads, since: Date.now() - 30 * DAY } },
  });
  if (!done.ok()) throw new Error(`could not save the inbox: ${done.status()}`);
}
