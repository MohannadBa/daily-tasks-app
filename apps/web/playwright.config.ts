import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the running Docker Compose stack:
 *   docker compose up -d --build && pnpm --filter @dailytasks/web test:e2e
 * Uses the locally installed Google Chrome (no browser download). Demo seed accounts required.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3001',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, testMatch: /responsive|pwa/ },
  ],
});
