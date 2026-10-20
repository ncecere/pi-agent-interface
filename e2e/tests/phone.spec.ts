import { expect, type Page, test } from '@playwright/test';
import { seedInbox, signInAs } from './helpers';

/**
 * On a phone, iOS Safari zooms into any text field under 16px when it is focused and stays zoomed, which is how the
 * page "breaks its scale". Every field a person can type in must be at least 16px on a touch screen, and no page may
 * be wider than the screen (a wide table scrolls inside its own box).
 */
test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'touch', 'a phone only');
  await signInAs(page, 'morgan');
  await page.request.get('/api/agents');
  await seedInbox(page, 'morgan.lee@example.com');
});

const smallFields = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select',
      ),
    ]
      .filter(
        (e) =>
          (e as HTMLElement).offsetParent && Number.parseFloat(getComputedStyle(e).fontSize) < 16,
      )
      .map(
        (e) =>
          `${e.tagName} ${e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? e.id} ${getComputedStyle(e).fontSize}`,
      ),
  );
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const PAGES = [
  '/',
  '/settings',
  '/settings/customization',
  '/settings/agents',
  '/settings/conversations',
  '/admin',
  '/admin/people',
  '/admin/agents',
  '/admin/branding',
  '/admin/features',
  '/admin/usage',
  '/admin/audit',
];

test('no page is wider than the phone, and no field is small enough to make it zoom', async ({
  page,
}) => {
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForTimeout(700);
    expect(await overflow(page), `${path} is wider than the screen`).toBeLessThanOrEqual(0);
    expect(await smallFields(page), `${path} has fields under 16px`).toEqual([]);
  }
});

test('the fields in dialogs and menus are big enough too', async ({ page }) => {
  await page.goto('/settings/agents');
  await page.getByRole('button', { name: /New agent/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await smallFields(page), 'new agent dialog').toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.keyboard.press('Escape');

  await page.goto('/admin/agents');
  await page.getByRole('button', { name: /Add a provided agent/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await smallFields(page), 'provided agent dialog').toEqual([]);
});

test('the composer is not a zoom trigger, and the page does not scroll sideways while typing', async ({
  page,
}) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message input' });
  await box.fill('A long message '.repeat(40));
  expect(
    Number.parseFloat(await box.evaluate((e) => getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test('the greeting keeps its comma on the first line', async ({ page }) => {
  await page.goto('/');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText(/work on,/);
  expect(await heading.innerText()).toMatch(/work on,\s*\n?Morgan\?/);
});
