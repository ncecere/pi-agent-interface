import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { seedInbox, setTheme, signInAs } from './helpers';

/**
 * Automated accessibility checks (axe, WCAG 2.0/2.1 A and AA) on the main pages, in the dark and the light theme.
 * It finds a part of what a person using a screen reader or a keyboard would; the rest is in docs "Accessibility".
 */
const THEMES = ['dark', 'light'] as const;

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
  }));
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });
    test('sign-in page', async ({ page }) => {
      await page.addInitScript((mode) => localStorage.setItem('oci.theme', mode), theme);
      await page.goto('/sign-in');
      await expect(page.getByText('Development accounts')).toBeVisible();
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      expect.soft(await violations(page), 'sign-in').toEqual([]);
    });

    test('chat: home, a row menu, the command palette and a conversation', async ({
      page,
    }, info) => {
      test.skip(
        info.project.name === 'touch',
        'these use hover and menus; the phone has its own test below',
      );
      await signInAs(page, 'priya');
      await setTheme(page, theme);
      await page.request.get('/api/agents');
      await seedInbox(page, 'priya.shah@example.com');
      await page.goto('/');
      await expect(page.getByRole('heading', { name: /What should/ })).toBeVisible();
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await page.waitForTimeout(1200); // fades finish
      expect.soft(await violations(page), 'home').toEqual([]);

      await page.locator('[data-focus-row]').first().hover();
      await page
        .getByRole('button', { name: /^More actions/ })
        .first()
        .click();
      await expect(page.getByRole('menu')).toBeVisible();
      expect.soft(await violations(page), 'a row menu').toEqual([]);
      await page.keyboard.press('Escape');

      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog')).toBeVisible();
      expect.soft(await violations(page), 'command palette').toEqual([]);
      await page.keyboard.press('Escape');

      await page.locator('a[title="Can I expense a standing desk?"]').click();
      await expect(page).toHaveURL(/\/threads\//);
      await page.waitForTimeout(1200);
      expect.soft(await violations(page), 'a conversation').toEqual([]);
    });

    test('a reply being written, and the dialogs', async ({ page }, info) => {
      test.skip(
        info.project.name === 'touch',
        'these use hover and menus; the phone has its own test below',
      );
      await signInAs(page, 'maria');
      await setTheme(page, theme);
      await page.goto('/');
      await page.getByRole('textbox', { name: 'Message input' }).fill('Say something at length.');
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
      await page.waitForTimeout(1200); // the new row and the reply fade in
      expect.soft(await violations(page), 'while the agent works').toEqual([]);
      await expect(page.getByText(/Understood\. I will look into that/)).toBeVisible({
        timeout: 20_000,
      });

      await page.goto('/settings/agents');
      await page.getByRole('button', { name: /New agent/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect.soft(await violations(page), 'new agent dialog').toEqual([]);
    });

    test('settings and administration', async ({ page }, info) => {
      test.skip(
        info.project.name === 'touch',
        'these use hover and menus; the phone has its own test below',
      );
      await signInAs(page, 'morgan');
      await setTheme(page, theme);
      for (const path of [
        '/settings',
        '/settings/customization',
        '/settings/agents',
        '/admin',
        '/admin/people',
        '/admin/agents',
        '/admin/branding',
        '/admin/features',
        '/admin/usage',
        '/admin/audit',
      ]) {
        await page.goto(path);
        await page.waitForTimeout(900);
        expect.soft(await violations(page), path).toEqual([]);
      }
    });
  });
}

test('on a phone: the sign-in page, and the conversation list in its drawer', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'touch', 'a phone only');
  await page.goto('/sign-in');
  await expect(page.getByText('Development accounts')).toBeVisible();
  expect.soft(await violations(page), 'sign-in').toEqual([]);
  await signInAs(page, 'priya');
  await page.request.get('/api/agents');
  await seedInbox(page, 'priya.shah@example.com');
  await page.goto('/');
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(page.locator('a[title="Can I expense a standing desk?"]')).toBeVisible();
  await page.waitForTimeout(1000);
  expect.soft(await violations(page), 'the drawer').toEqual([]);
});

const ACCENTS = ['neutral', 'blue', 'violet', 'emerald'] as const;

for (const theme of THEMES) {
  for (const accent of ACCENTS) {
    test(`${accent} accent, ${theme} theme: the buttons and highlights keep their contrast`, async ({
      page,
    }) => {
      await signInAs(page, 'maria');
      const me = await (await page.request.get('/api/me')).json();
      await page.request.put('/api/me/prefs/appearance', {
        headers: { 'X-CSRF-Token': me.data.csrfToken },
        data: { value: { theme, colorTheme: accent } },
      });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-color-theme', accent);
      await page.getByRole('textbox', { name: 'Message input' }).fill('Hello');
      await page.waitForTimeout(1000);
      expect.soft(await violations(page), 'home with a message typed').toEqual([]);
      await page.goto('/settings/customization');
      await page.waitForTimeout(900);
      expect.soft(await violations(page), 'customization').toEqual([]);
    });
  }
}

test('with reduced motion asked for, nothing on the page keeps moving while the agent works', async ({
  page,
}) => {
  const looping = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === 'running' &&
              (a.effect as KeyframeEffect | null)?.getComputedTiming().iterations === Infinity,
          ).length,
    );
  await signInAs(page, 'maria');
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message input' }).fill('Say something at length.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
  await page.waitForTimeout(600);
  // The check can fail: with motion allowed, the working avatar and the row's spinner are animating.
  expect(await looping()).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  expect(await looping()).toBe(0);
});

test('a keyboard alone: the first Tab offers to skip to the content, and every stop shows where focus is', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'touch', 'a keyboard');
  await signInAs(page, 'priya');
  await page.request.get('/api/agents');
  await seedInbox(page, 'priya.shah@example.com');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /What should/ })).toBeVisible();
  await page.waitForTimeout(1000);

  // The first stop in the page is the skip link, and it works: focus moves into the content.
  const first = await page.evaluate(
    () =>
      document.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
      )?.textContent,
  );
  expect(first).toMatch(/Skip to main content/);
  await page.getByRole('link', { name: 'Skip to main content' }).focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.closest('#main-content') !== null)).toBe(
    true,
  );

  const stops: { name: string; shown: boolean }[] = [];
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return { name: '(none)', shown: true };
        const style = getComputedStyle(el);
        // A ring is an outline or a shadow; a row may show it on its parent (focus-within).
        const own = (s: CSSStyleDeclaration) =>
          (s.outlineStyle !== 'none' && Number.parseFloat(s.outlineWidth) > 0) ||
          (s.boxShadow !== 'none' && s.boxShadow !== '');
        const shown =
          own(style) || (el.parentElement ? own(getComputedStyle(el.parentElement)) : false);
        const name =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent?.trim().slice(0, 40) ||
          el.tagName;
        return { name: `${el.tagName.toLowerCase()} ${name}`, shown };
      }),
    );
  }
  expect(stops.filter((stop) => !stop.shown)).toEqual([]);
  // It goes somewhere: more than the sidebar's first few stops, and not stuck.
  expect(new Set(stops.map((stop) => stop.name)).size).toBeGreaterThan(20);
});
