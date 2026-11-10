import { defineConfig } from '@playwright/test';

/**
 * Read-only smoke against a deployed instance. It logs in with an admin token
 * (E2E_ADMIN_TOKEN) and checks the pages where we have regressed layout or
 * picker behaviour before. Run with:
 *   E2E_ADMIN_TOKEN=... npm run e2e
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://iptv.xu05236.dpdns.org',
    trace: 'retain-on-failure',
  },
});
