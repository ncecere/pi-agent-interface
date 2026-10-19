import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

test.describe('sign-in and chat', () => {
  test('the sign-in page offers the development accounts, and signing in shows the person\u2019s agent', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'touch', 'the drawer layout is covered by the inbox tests');
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByText('Development accounts')).toBeVisible();
    await page.getByRole('button', { name: /Priya Shah/ }).click();
    await expect(
      page.getByRole('heading', { name: /What should Assistant work on, Priya\?/ }),
    ).toBeVisible();
  });

  test('a message is answered, streamed, with its time, model and tokens beneath', async ({
    page,
  }) => {
    await signInAs(page, 'priya');
    await page.goto('/');
    const box = page.getByRole('textbox', { name: 'Message input' });
    await box.fill('Please look into the Q4 budget.');
    await page.getByRole('button', { name: 'Send message' }).click();
    // The conversation opens with the message and an answer that arrives as it is written.
    await expect(page).toHaveURL(/\/threads\//);
    await expect(page.getByText('Please look into the Q4 budget.').first()).toBeVisible();
    await expect(page.getByText(/Understood\. I will look into that/)).toBeVisible({
      timeout: 20_000,
    });
    // v0.3.0: when, which model, and how many tokens, once the reply is whole.
    await expect(page.getByText(/chat-model/)).toBeVisible({ timeout: 20_000 });
    // It is a conversation in the sidebar now.
    await page.reload();
    await expect(page.getByText('Please look into the Q4 budget.').first()).toBeVisible();
  });

  test('the command palette opens from the keyboard and closes again', async ({ page }, info) => {
    test.skip(info.project.name === 'touch', 'a keyboard');
    await signInAs(page, 'priya');
    await page.goto('/');
    // The app has to be up before it hears the shortcut.
    await expect(page.getByRole('heading', { name: /What should/ })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.type('expense');
    // Asking an agent about it is offered with the words typed.
    await expect(page.getByText(/Ask Assistant: .expense/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('who sees the administration', () => {
  test('a member has no Admin dashboard, and the server refuses them', async ({ page }, info) => {
    test.skip(info.project.name === 'touch', 'the user menu is in the drawer on a phone');
    await signInAs(page, 'priya');
    await page.goto('/');
    await page.getByRole('button', { name: 'Priya Shah' }).first().click();
    await expect(page.getByRole('menuitem', { name: /Admin dashboard/ })).toHaveCount(0);
    const refused = await page.request.get('/api/admin/people');
    expect(refused.status()).toBe(403);
  });

  test('an administrator opens the dashboard and sees the people who have signed in', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'touch', 'the admin tables are for a desktop');
    await signInAs(page, 'morgan');
    await page.goto('/admin/people');
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    await expect(page.getByText('morgan.lee@example.com')).toBeVisible();
    await expect(page.getByText('Administrator').first()).toBeVisible();
  });
});
