import { expect, test } from '@playwright/test';
import { API, apiToken, signIn, USERS } from './helpers';

/**
 * Critical business workflow across two real browsers (manager + employee), including live
 * WebSocket updates and rating privacy enforced by the backend.
 */
test('manager assigns → employee sees it live, replies with a file, completes → manager rates; employee can never see the rating', async ({ browser }) => {
  test.setTimeout(150_000);
  const title = `E2E ${Date.now()}`;
  const mgr = await signIn(browser, USERS.manager, 'en');
  const emp = await signIn(browser, USERS.employee, 'en');

  // Employee sits on the dashboard with live updates connected.
  await emp.page.goto('/');
  await expect(emp.page.getByRole('status').filter({ hasText: /^Live$/ }).first()).toBeVisible({ timeout: 15_000 });
  const badge = emp.page.locator('aside a[href="/notifications"] span.rounded-full');
  const before = Number((await badge.textContent().catch(() => '0')) || '0');

  // Manager creates the task through the UI.
  await mgr.page.goto('/tasks/new');
  await mgr.page.waitForLoadState('networkidle'); // hydrated, projects loaded
  await mgr.page.getByLabel('Project').selectOption({ label: 'Riyadh Office Tower' });
  const assignee = mgr.page.getByLabel('Assign to');
  await expect(assignee).toBeEnabled();
  await expect(assignee.locator('option', { hasText: 'Omar Employee' })).toHaveCount(1);
  await assignee.selectOption({ label: 'Omar Employee' });
  await mgr.page.getByLabel('Title').fill(title);
  await mgr.page.getByLabel('Description').fill('Created by the end-to-end test');
  await mgr.page.locator('input[type=datetime-local]').fill('2030-05-01T14:30');
  await mgr.page.getByRole('button', { name: 'Create task' }).click();
  await expect(mgr.page.getByRole('heading', { name: title })).toBeVisible();
  const taskUrl = mgr.page.url();
  const taskId = taskUrl.split('/tasks/')[1]!;
  // Deadline typed as Riyadh time is shown back as the same wall time.
  await expect(mgr.page.getByText(/May 1, 2030.*2:30/).first()).toBeVisible();

  // Live update on the employee's open page — no reload: toast + unread badge.
  await expect(emp.page.getByText('A new task was assigned to you')).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => Number((await badge.textContent()) || '0'), { timeout: 15_000 }).toBeGreaterThan(before);

  // Employee replies with an attachment (pre-signed S3 upload with progress), then completes.
  await emp.page.goto(`/tasks/${taskId}`);
  await emp.page.getByPlaceholder('Write a reply…').fill('Started, photo attached');
  await emp.page.locator('input[type=file]').setInputFiles({ name: 'site.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a8f60000000049454e44ae426082', 'hex') });
  await emp.page.getByRole('button', { name: 'Send reply' }).click();
  await expect(emp.page.getByText('Reply sent')).toBeVisible();
  await expect(emp.page.getByRole('button', { name: /site\.png/ })).toBeVisible();

  await emp.page.getByRole('tab', { name: 'Complete task' }).click();
  const complete = emp.page.getByRole('button', { name: 'Mark as completed' });
  await expect(complete).toBeDisabled(); // a non-empty completion comment is required
  await emp.page.getByPlaceholder('Describe the completed work (required)…').fill('All done, area is clean');
  await complete.click();
  await expect(emp.page.getByText('Task completed', { exact: true }).first()).toBeVisible();
  await expect(emp.page.getByText('Completion report')).toBeVisible();

  // Manager's open task page updates live, then the manager rates privately.
  await expect(mgr.page.getByText('A task was completed')).toBeVisible({ timeout: 20_000 });
  await mgr.page.reload();
  await mgr.page.getByRole('radio', { name: '4 stars' }).click();
  await mgr.page.getByLabel('Private feedback (optional)').fill('Good, a bit late on photos');
  await mgr.page.getByRole('button', { name: 'Save rating' }).click();
  await expect(mgr.page.getByText('Rating saved')).toBeVisible();

  // Employee: no rating anywhere in the UI …
  await emp.page.reload();
  await expect(emp.page.getByText('Performance rating')).toHaveCount(0);
  await expect(emp.page.getByText('Good, a bit late on photos')).toHaveCount(0);
  // … and the backend refuses direct requests, through the BFF and straight to the API.
  const viaBff = await emp.page.evaluate(async (id) => (await fetch(`/bff/tasks/${id}/rating`)).status, taskId);
  expect(viaBff).toBe(403);
  const { token } = await apiToken(USERS.employee);
  const direct = await fetch(`${API}/tasks/${taskId}/rating`, { headers: { Authorization: `Bearer ${token}` } });
  expect(direct.status).toBe(403);
  const detail = await (await fetch(`${API}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(JSON.stringify(detail)).not.toMatch(/stars|feedback/);
  const perf = await fetch(`${API}/performance/employees`, { headers: { Authorization: `Bearer ${token}` } });
  expect(perf.status).toBe(403);
  // Another employee cannot open the task at all (404, IDOR-safe).
  const other = await apiToken(USERS.otherEmployee);
  expect((await fetch(`${API}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${other.token}` } })).status).toBe(404);

  await mgr.context.close();
  await emp.context.close();
});

test('signed-out users are redirected to login and return to the deep link afterwards', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/tasks?view=overdue');
  await expect(page).toHaveURL(/\/login\?next=%2Ftasks%3Fview%3Doverdue/);
  await page.locator('input[type=email]').fill(USERS.employee);
  await page.locator('input[type=password]').fill('wrong-password');
  await page.locator('form button[type=submit]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.locator('input[type=password]').fill(process.env.SEED_DEMO_PASSWORD ?? 'Password123!');
  await page.locator('form button[type=submit]').click();
  await expect(page).toHaveURL(/\/tasks\?view=overdue/);
  await context.close();
});

test('password recovery page works signed out and explains local mode honestly', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: /نسيت كلمة المرور|Forgot password/ }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await page.locator('input[type=email]').fill(USERS.employee);
  await page.locator('form button[type=submit]').click();
  // Docker runs AUTH_MODE=local (no e-mail delivery): the API answers 501 and the page says so.
  await expect(page.locator('form [role=alert]')).toContainText(/administrator|المسؤول/);
});
