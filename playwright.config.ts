import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks against an already-running stack.
 *
 * The stack is started by CI's smoke job (or `scripts/dev-stack` locally) —
 * this config deliberately does not manage servers, so the pages tested are
 * exactly the ones the smoke test already proved reachable.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: process.env.E2E_SITE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    // A pre-provisioned Chromium (dev containers, some CI images) beats a
    // per-run download; unset, Playwright uses its own managed browser.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    /**
     * The audience this platform serves reaches it from phones — a check
     * that only ever runs at 1280px would miss the layout most visitors get.
     */
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
