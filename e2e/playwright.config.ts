import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against a built copy of the app (`pnpm build` first) and a fake platform
 * (e2e/platform: the fictional Example Corp). Needs Postgres: the development one (`pnpm db:up`)
 * or TEST_DATABASE_URL. Run with `pnpm e2e`.
 */
const SERVICE = 'http://localhost:5291';
const CONNECT = 'http://localhost:5292';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]]
    : 'list',
  outputDir: '../test-results',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { trace: 'retain-on-failure', colorScheme: 'dark', timezoneId: 'America/Los_Angeles' },
  webServer: [
    {
      command: 'node platform/fake-platform.mjs',
      cwd: '.',
      url: 'http://127.0.0.1:8299/healthz',
      env: {
        FAKE_PORT: '8299',
        FAKE_URL: 'http://localhost:8299',
        FAKE_TZ: 'America/Los_Angeles',
        FAKE_SERVICE_TEAM: 'example-corp',
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node serve.mjs service',
      cwd: '.',
      url: `${SERVICE}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node serve.mjs connect',
      cwd: '.',
      url: `${CONNECT}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        baseURL: SERVICE,
      },
    },
    {
      // A phone: a coarse pointer, so the inbox draws its row buttons the way a touch screen does.
      name: 'touch',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        baseURL: SERVICE,
        launchOptions: {
          args: [
            '--blink-settings=primaryPointerType=4,availablePointerTypes=4,hoverTypes=1,availableHoverTypes=1',
          ],
        },
      },
    },
  ],
});
