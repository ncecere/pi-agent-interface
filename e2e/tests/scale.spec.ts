import { expect, test } from '@playwright/test';
import { addConversations, saveInbox, signInAs } from './helpers';

/**
 * A person who has used the app for a long time: 1,500 conversations with one agent. Without paging the sidebar
 * drew every one of them (about 2,000 rows and 100,000 elements for 2,000 conversations, five seconds to the
 * first row, half a second for each search keystroke).
 */
const COUNT = 1500;
const rows = (page: import('@playwright/test').Page) => page.locator('[data-focus-row]');

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name === 'touch', 'the same list on a phone; desktop is enough');
  await signInAs(page, 'noah');
  await addConversations(page, 'noah.patel@example.com', COUNT);
  await page.goto('/');
  await expect(rows(page).first()).toBeVisible();
});

test('draws a page at a time, and "Show more" adds the next', async ({ page }) => {
  // The first page, not the 1,500: a few dozen rows and a page of elements.
  const first = await rows(page).count();
  expect(first).toBeGreaterThan(30);
  expect(first).toBeLessThan(60);
  expect(await page.evaluate(() => document.getElementsByTagName('*').length)).toBeLessThan(6000);

  const more = page.getByRole('button', { name: /^Show 40 more/ });
  await expect(more).toBeVisible();
  await expect(more).toContainText(/\d+ not shown/);
  await more.click();
  await expect.poll(() => rows(page).count()).toBe(first + 40);
});

test('a search looks through all of them, and clearing it goes back to the first page', async ({
  page,
}) => {
  const box = page.getByRole('textbox', { name: 'Search conversations' });
  await box.fill('Conversation 1234');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('a[title^="Conversation 1234"]')).toBeVisible();
  await box.fill('');
  await expect.poll(() => rows(page).count()).toBeLessThan(60);

  // Many matches are paged too.
  await box.fill('quarterly planning');
  await expect(page.getByRole('button', { name: /^Show 40 more/ })).toBeVisible();
  expect(await rows(page).count()).toBeLessThan(60);
});

test('the open conversation stays in the list, however far down it is', async ({ page }) => {
  const agentId = (await (await page.request.get('/api/agents')).json()).data[0].id as string;
  await page.goto(`/agents/${agentId}/threads/t-bulk-01400`);
  await expect(page.locator('a[title^="Conversation 1400"]')).toBeVisible();
  expect(await rows(page).count()).toBeLessThan(60);
});

test('settled conversations are paged too, and a search opens the shelf that holds the match', async ({
  page,
}) => {
  const agentId = (await (await page.request.get('/api/agents')).json()).data[0].id as string;
  const threads: Record<string, Record<string, number>> = {};
  const now = Date.now();
  for (let i = 0; i < 120; i++)
    threads[`${agentId}/t-bulk-${String(i).padStart(5, '0')}`] = {
      _at: now,
      settledAt: now - i * 60_000,
    };
  await saveInbox(page, threads);
  await page.reload();

  const shelf = page.getByRole('button', { name: /^Settled/ });
  await expect(shelf).toBeVisible();
  await expect(shelf).toContainText('(120)');
  // Closed: nothing of it is drawn.
  const closed = await rows(page).count();
  await shelf.click();
  await expect.poll(() => rows(page).count()).toBeGreaterThan(closed + 30);
  await expect(page.getByRole('button', { name: /^Show 40 more/ }).first()).toBeVisible();
  await shelf.click();

  // A search finds a settled one even with the shelf closed.
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('Conversation 0100');
  await expect(page.locator('a[title^="Conversation 0100"]')).toBeVisible();
});

test('Settings › Conversations pages the settled list and can search it', async ({ page }) => {
  const agentId = (await (await page.request.get('/api/agents')).json()).data[0].id as string;
  const threads: Record<string, Record<string, number>> = {};
  const now = Date.now();
  for (let i = 0; i < 120; i++)
    threads[`${agentId}/t-bulk-${String(i).padStart(5, '0')}`] = {
      _at: now,
      archivedAt: now - i * 60_000,
    };
  await saveInbox(page, threads);
  await page.goto('/settings/conversations');
  await expect(page.getByText('Select all (120)')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^Select Conversation/ })).toHaveCount(40);
  await page.getByRole('button', { name: /^Show 40 more/ }).click();
  await expect(page.getByRole('checkbox', { name: /^Select Conversation/ })).toHaveCount(80);
  await page
    .getByRole('searchbox', { name: /Search archived and settled/ })
    .fill('Conversation 0107');
  await expect(page.getByRole('checkbox', { name: /^Select Conversation/ })).toHaveCount(1);
});
