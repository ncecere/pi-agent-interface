import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seedInbox, setFeature, signInAs } from './helpers';

/**
 * Searching inside messages (the messageSearch feature, off by default): the app keeps its own searchable copy of the
 * conversations a person opens, so a word said in a conversation (not in its title) finds it.
 */
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name === 'touch', 'desktop only');
  await signInAs(page, 'morgan');
  await setFeature(page, 'messageSearch', true);
  await signInAs(page, 'priya');
  await page.request.get('/api/agents');
  await seedInbox(page, 'priya.shah@example.com');
});

test.afterEach(async ({ page }) => {
  await signInAs(page, 'morgan');
  await setFeature(page, 'messageSearch', false);
});

test('finds a conversation by a word in its messages, once it has been opened', async ({
  page,
}) => {
  const box = page.getByRole('textbox', { name: 'Search conversations' });
  await page.goto('/');
  await expect(page.locator('a[title="Can I expense a standing desk?"]')).toBeVisible();
  // Not opened here yet: nothing of it is known, whatever the platform has.
  await box.fill('receipt');
  await expect(page.getByText('No messages match.')).toBeVisible();
  await expect(page.getByText('Only conversations opened in this app are searched.')).toBeVisible();
  await box.fill('');

  // Open it. (Its text is kept a moment after the transcript settles.)
  await page.locator('a[title="Can I expense a standing desk?"]').click();
  await expect(page.getByText(/one desk up to \$600/)).toBeVisible();
  await page.waitForTimeout(2000);

  await page.goto('/');
  await box.fill('receipt');
  const hit = page
    .getByRole('list', { name: 'Conversations whose messages match' })
    .getByRole('link');
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('Can I expense a standing desk?');
  await expect(hit.locator('mark')).toHaveText('receipt');
  const found = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(found.violations.map((v) => v.id)).toEqual([]);
  await hit.click();
  await expect(page).toHaveURL(/t-expense-policy/);
});

test('finds the start of a word, every word asked for, and nothing from anyone else', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('a[title="Can I expense a standing desk?"]').click();
  await expect(page.getByText(/one desk up to \$600/)).toBeVisible();
  await page.waitForTimeout(2000);
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Search conversations' });
  const hits = page
    .getByRole('list', { name: 'Conversations whose messages match' })
    .getByRole('link');

  await box.fill('home-off');
  await expect(hits).toHaveCount(1);
  await box.fill('equip receipt');
  await expect(hits).toHaveCount(1);
  await box.fill('receipt zebra');
  await expect(page.getByText('No messages match.')).toBeVisible();

  // Someone else has opened nothing of theirs: their search finds none of Priya's.
  await signInAs(page, 'noah');
  const theirs = await (await page.request.get('/api/search?q=receipt')).json();
  expect(theirs.data.results).toEqual([]);
});

test('is not offered when it is off', async ({ page }) => {
  await signInAs(page, 'morgan');
  await setFeature(page, 'messageSearch', false);
  await signInAs(page, 'priya');
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('receipt');
  await expect(page.getByText('In messages')).toHaveCount(0);
  expect((await page.request.get('/api/search?q=receipt')).status()).toBe(404);
});
