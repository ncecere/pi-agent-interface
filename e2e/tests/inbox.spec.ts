import { expect, test } from '@playwright/test';
import { drawnOpacity, overlap, seedInbox, signInAs } from './helpers';

/**
 * The work inbox in the sidebar: what a conversation needs shows in its row's corner; the row's actions appear over
 * the corner on hover (or stay beside it on a touch screen). v0.3.1 fixed the status being drawn over the actions.
 */
const DONE = 'Can I expense a standing desk?';
const row = (page: import('@playwright/test').Page, title: string) =>
  // By the link's title attribute, not its role: an open menu hides the rest of the page from the accessibility tree.
  page.locator('[data-focus-row]', { has: page.locator(`a[title="${title}"]`) });

test.beforeEach(async ({ page }) => {
  await signInAs(page, 'priya');
  // Her agent is made the first time the app lists them; then the canned conversations are on the platform.
  await page.request.get('/api/agents');
  await seedInbox(page, 'priya.shah@example.com');
  await page.goto('/');
  // On a phone the sidebar is a drawer.
  const open = page.getByRole('button', { name: 'Open sidebar' });
  if (await open.isVisible()) await open.click();
  await expect(row(page, DONE)).toBeVisible();
});

test('shows what each conversation needs: working, done, failed, woke', async ({ page }) => {
  await expect(row(page, DONE).getByText('Done', { exact: true })).toBeVisible();
  await expect(
    row(page, 'Export the churn report to CSV').getByText('Failed', { exact: true }),
  ).toBeVisible();
  await expect(
    row(page, 'Reschedule the offsite').getByText('Woke', { exact: true }),
  ).toBeVisible();
});

test('settling a conversation moves it out of the inbox, and un-settling brings it back', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'touch', 'a phone has no hover; it uses the row menu');
  await row(page, DONE).hover();
  await page.getByRole('button', { name: `Settle: ${DONE}` }).click();
  await expect(row(page, DONE)).toHaveCount(0);
  // It is on the Settled shelf, collapsed.
  await page.getByRole('button', { name: /Settled/ }).click();
  await expect(row(page, DONE)).toBeVisible();
  await row(page, DONE).hover();
  await page.getByRole('button', { name: `Un-settle: ${DONE}` }).click();
  await expect(row(page, DONE).getByText('Done', { exact: true })).toBeVisible();
});

test('the status steps aside for the actions, and never lies under them', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'touch', 'a touch screen has no hover');
  const status = row(page, DONE).getByText('Done', { exact: true });
  await expect.poll(() => drawnOpacity(status)).toBe(1);
  await row(page, DONE).hover();
  await expect(page.getByRole('button', { name: `Settle: ${DONE}` })).toBeVisible();
  await expect.poll(() => drawnOpacity(status)).toBe(0);
});

test('with a row\u2019s menu open its status stays out of the way', async ({ page }, info) => {
  test.skip(info.project.name === 'touch', 'covered by the touch test below');
  const status = row(page, DONE).getByText('Done', { exact: true });
  await row(page, DONE).hover();
  await page.getByRole('button', { name: `More actions: ${DONE}` }).click();
  await expect(page.getByRole('menuitem', { name: 'Settle' })).toBeVisible();
  // The pointer is in the menu now, not on the row; the status must still not come back under the actions.
  await page.getByRole('menuitem', { name: 'Archive' }).hover();
  await expect.poll(() => drawnOpacity(status)).toBe(0);
  await page.keyboard.press('Escape');
});

test('on a touch screen the status keeps clear of the "…" button and the pin', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'touch', 'a coarse pointer only');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  const rowEl = row(page, DONE);
  const status = rowEl.getByText('Done', { exact: true });
  const more = page.getByRole('button', { name: `More actions: ${DONE}` });
  await expect(more).toBeVisible();
  await expect.poll(() => drawnOpacity(status)).toBe(1);
  expect(await overlap(status, more)).toBe(false);
  const pinned = row(page, 'Release checklist for v2.4');
  expect(
    await overlap(
      pinned.getByLabel('Pinned'),
      page.getByRole('button', { name: 'More actions: Release checklist for v2.4' }),
    ),
  ).toBe(false);
});
