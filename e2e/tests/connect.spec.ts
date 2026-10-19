import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * Connect mode (the second app, on :5292): the person signs in to the chat app, then connects their own platform
 * account once (OAuth with PKCE against the fake platform, which approves as Priya); their agents live in their own
 * workspace there.
 */
const CONNECT = 'http://localhost:5292';

/** The fake platform approves whoever it is told to: the person who is connecting. */
const approveAs = (email: string) =>
  fetch('http://127.0.0.1:8299/__demo/connect-as', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
test.use({ baseURL: CONNECT });

test('connecting once, using the agents, and disconnecting', async ({ page }, info) => {
  test.skip(info.project.name === 'touch', 'the same on a phone; desktop is enough');
  await approveAs('priya.shah@example.com');
  await page.goto('/sign-in');
  await page.getByRole('button', { name: /Priya Shah/ }).click();

  // Signed in here, but not connected to the platform yet.
  await expect(page.getByRole('heading', { name: 'Connect your agents' })).toBeVisible();
  await expect(page.getByText('Signed in as priya.shah@example.com')).toBeVisible();

  await page.getByRole('link', { name: /^Connect/ }).click();
  // Back from the platform, connected: her agents.
  await expect(page.getByRole('heading', { name: /What should .* work on, Priya\?/ })).toBeVisible({
    timeout: 20_000,
  });

  await page.goto('/settings');
  await expect(page.getByText('Agent platform', { exact: true })).toBeVisible();
  await expect(page.getByText('priya.shah@example.com').last()).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('heading', { name: 'Connect your agents' })).toBeVisible({
    timeout: 15_000,
  });
});

test('Admin › Usage is not offered with Connect, and says why', async ({ page }, info) => {
  test.skip(info.project.name === 'touch', 'desktop only');
  await approveAs('morgan.lee@example.com');
  await page.goto('/sign-in');
  await page.getByRole('button', { name: /Morgan Lee/ }).click();
  await page.getByRole('link', { name: /^Connect/ }).click();
  await expect(page.getByRole('heading', { name: /What should .* work on/ })).toBeVisible({
    timeout: 20_000,
  });
  const features = await page.request.get('/api/admin/features');
  const body = await features.json();
  const usage = (body.data as { id: string; enabled: boolean; lockedReason?: string }[]).find(
    (f) => f.id === 'usage',
  );
  expect(usage?.enabled).toBe(false);
  expect(usage?.lockedReason).toBeTruthy();
});

test('Admin › Usage with Connect: each connected person, and who is not covered', async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name === 'touch', 'desktop only');
  // Priya signs in to this app and never connects.
  const other = await browser.newContext({ baseURL: CONNECT });
  const priya = await other.newPage();
  await priya.goto('/sign-in');
  await priya.evaluate(() =>
    fetch('/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'priya' }),
    }),
  );
  await other.close();

  await approveAs('morgan.lee@example.com');
  await page.goto('/sign-in');
  await page.getByRole('button', { name: /Morgan Lee/ }).click();
  // Connected already by an earlier test, or about to be.
  const connect = page.getByRole('link', { name: /^Connect/ });
  const chat = page.getByRole('heading', { name: /What should .* work on/ });
  await expect(connect.or(chat)).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByRole('heading', { name: /What should .* work on/ })).toBeVisible({
    timeout: 20_000,
  });

  // Off to begin with: no page, no menu entry.
  await page.goto('/admin/features');
  const usage = page.getByRole('switch', { name: 'Usage of connected people' });
  await expect(usage).not.toBeChecked();
  await expect(page.getByRole('link', { name: 'Usage', exact: true })).toHaveCount(0);
  await usage.click();
  await expect(usage).toBeChecked();

  await page.getByRole('link', { name: 'Usage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
  await expect(page.getByText('Not covered')).toBeVisible();
  await expect(page.getByRole('row', { name: /Morgan Lee/ })).toBeVisible();
  const missing = page
    .getByRole('region', { name: 'Not in these figures' })
    .or(page.locator('section[aria-labelledby="usage-coverage"]'));
  await expect(missing.getByText('Priya Shah')).toBeVisible();
  await expect(missing.getByText('Has not connected').first()).toBeVisible();
  const found = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    found.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
});
