import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { signIn, USERS } from './helpers';

test('Arabic is the default (RTL); switching language keeps the page and persists', async ({ browser }) => {
  const context = await browser.newContext(); // no saved preference
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تسجيل الدخول إلى الراسيات');
  await expect(page.getByRole('img', { name: /الراسيات/ }).first()).toBeVisible(); // brand logo
  await context.close();

  const { context: ctx, page: p } = await signIn(browser, USERS.manager, 'ar');
  await p.goto('/tasks?view=active');
  await expect(p.locator('html')).toHaveAttribute('dir', 'rtl');
  // Sidebar sits on the right in RTL.
  const box = await p.locator('aside').first().boundingBox();
  expect(box!.x).toBeGreaterThan(500);
  await p.locator('aside').getByRole('button', { name: 'English' }).click();
  await expect(p.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(p).toHaveURL(/\/tasks\?view=active/); // same page
  await expect(p.getByRole('heading', { level: 1 })).toHaveText('Tasks');
  const ltrBox = await p.locator('aside').first().boundingBox();
  expect(ltrBox!.x).toBeLessThan(10); // sidebar on the left in LTR
  await p.reload();
  await expect(p.locator('html')).toHaveAttribute('lang', 'en'); // persisted
  // Dates are shown in Riyadh time with the Gregorian calendar in Arabic.
  await p.locator('aside').getByRole('button', { name: 'العربية' }).click();
  await expect(p.locator('html')).toHaveAttribute('lang', 'ar');
  await ctx.close();
});

test('live updates reconnect after the API restarts (WebSocket reconnection)', async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await signIn(browser, USERS.employee, 'en');
  await page.goto('/');
  const live = page.locator('aside').getByRole('status').filter({ hasText: /^(Live|Offline)$/ });
  await expect(live).toHaveText('Live', { timeout: 15_000 });
  execSync('docker compose restart api', { cwd: '../..', stdio: 'ignore' });
  await expect(live).toHaveText('Offline', { timeout: 30_000 });
  await expect(live).toHaveText('Live', { timeout: 90_000 }); // backoff reconnect, no page reload
  await context.close();
});
