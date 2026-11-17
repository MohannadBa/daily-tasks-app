import { expect, test, type Page } from '@playwright/test';
import { API, apiToken, PASSWORD, signIn, USERS } from './helpers';

/**
 * Enterprise workflows end to end through the real UI, BFF, API, worker and database:
 * onboarding, approval, rejection, transfer chain, extensions, documents, personal tasks, reports.
 * API calls are used only to create fixtures quickly, never to perform the step under test.
 */

const H = 3600_000;
const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

let ctxCache: { mgr: string; emp: string; emp2: string; towerId: string; deptId: string; empId: string; emp2Id: string } | null = null;
async function fixtures() {
  if (ctxCache) return ctxCache;
  const mgr = await apiToken(USERS.manager);
  const emp = await apiToken(USERS.employee);
  const emp2 = await apiToken(USERS.otherEmployee);
  const projects = (await call(mgr.token, 'GET', '/projects')).body as Array<{ id: string; name: string }>;
  const depts = (await call(mgr.token, 'GET', '/departments')).body as Array<{ id: string; code: string }>;
  ctxCache = {
    mgr: mgr.token,
    emp: emp.token,
    emp2: emp2.token,
    towerId: projects.find((p) => p.name === 'Riyadh Office Tower')!.id,
    deptId: depts.find((d) => d.code === 'PROJECT_MANAGEMENT')!.id,
    empId: emp.user.id,
    emp2Id: emp2.user.id,
  };
  return ctxCache;
}

async function createTask(title: string, hours = 48) {
  const f = await fixtures();
  const r = await call(f.mgr, 'POST', '/tasks', { projectId: f.towerId, departmentId: f.deptId, assigneeId: f.empId, title, deadline: new Date(Date.now() + hours * H).toISOString() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a8f60000000049454e44ae426082', 'hex');

async function submitViaUi(page: Page, taskId: string, comment: string, file?: string) {
  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('tab', { name: 'Submit completion' }).click();
  await page.getByPlaceholder('Describe the completed work (required)…').fill(comment);
  if (file) await page.locator('input[type=file]').setInputFiles({ name: file, mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Submitted for approval', { exact: true }).first()).toBeVisible();
}

const reviewCard = (page: Page, title: string) => page.locator('li').filter({ has: page.getByRole('link', { name: title, exact: true }) });

test('1/2/18. admin creates a department and an employee; the employee must replace the temporary password at first sign-in', async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await signIn(browser, USERS.admin, 'en');
  const code = `QA_${letters()}`;
  const nameEn = `Quality ${code}`;
  await admin.page.goto('/departments');
  await admin.page.getByRole('button', { name: 'New department' }).click();
  await admin.page.getByRole('textbox', { name: 'Code' }).fill(code);
  await admin.page.getByRole('textbox', { name: 'Arabic name' }).fill(`الجودة ${code}`);
  await admin.page.getByRole('textbox', { name: 'English name' }).fill(nameEn);
  await admin.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(admin.page.getByText('Department created')).toBeVisible();
  await expect(admin.page.getByText(nameEn)).toBeVisible();

  const email = `new.${tag()}@dailytasks.local`;
  await admin.page.goto('/users');
  await admin.page.getByRole('button', { name: 'New account' }).click();
  await admin.page.getByRole('textbox', { name: 'Full name' }).fill('Nora Newcomer');
  await admin.page.getByRole('textbox', { name: 'Email' }).fill(email);
  await admin.page.getByRole('checkbox', { name: nameEn }).check();
  await admin.page.getByRole('combobox', { name: 'Role in Riyadh Office Tower' }).selectOption('EMPLOYEE');
  await admin.page.getByRole('button', { name: 'Create account' }).click();
  const temp = (await admin.page.getByTestId('temporary-password').textContent())!.trim();
  expect(temp).toMatch(/^[A-Za-z2-9]{16}$/);
  // Never persisted in browser storage.
  const stored = await admin.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain(temp);
  await admin.page.getByRole('button', { name: 'Done' }).click();
  await expect(admin.page.getByTestId('temporary-password')).toHaveCount(0);

  // First sign-in: forced password change before anything else.
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'dt_locale', value: 'en', url: 'http://localhost:3001' }]);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(temp);
  await page.locator('form button[type=submit]').click();
  await expect(page.getByText('Welcome! Choose your own password')).toBeVisible();
  await page.getByLabel('Choose a new password').fill('weak');
  await page.getByLabel('Confirm new password').fill('weak');
  await page.locator('form button[type=submit]').click();
  await expect(page.locator('form [role=alert]')).toContainText('At least 8 characters');
  await page.getByLabel('Choose a new password').fill('Newcomer2030');
  await page.getByLabel('Confirm new password').fill('Newcomer2030');
  await page.locator('form button[type=submit]').click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: /Welcome, Nora/ })).toBeVisible();
  await ctx.close();
  await admin.context.close();

  // Clean up the test department and account so repeated runs don't clutter real lists.
  const { token } = await apiToken(USERS.admin);
  const dept = ((await call(token, 'GET', '/departments')).body as Array<{ id: string; code: string }>).find((d) => d.code === code);
  if (dept) expect((await call(token, 'PATCH', `/departments/${dept.id}`, { isActive: false })).status).toBe(200);
  const nora = ((await call(token, 'GET', `/users?q=${encodeURIComponent(email)}`)).body as Array<{ id: string }>)[0];
  if (nora) expect((await call(token, 'PATCH', `/users/${nora.id}`, { isActive: false })).status).toBe(200);
});

test('5/6/7/8/15. employee starts, submits with an image; manager approves from the review inbox; time is final; the file appears in project Documents (managers only)', async ({ browser }) => {
  test.setTimeout(120_000);
  const f = await fixtures();
  const title = `Approve ${tag()}`;
  const id = await createTask(title);
  const emp = await signIn(browser, USERS.employee, 'en');
  await emp.page.goto(`/tasks/${id}`);
  await emp.page.getByRole('button', { name: 'Start task' }).click();
  await expect(emp.page.getByText('Work started')).toBeVisible();
  await submitViaUi(emp.page, id, 'Installed and tested', 'handover.png');
  await expect(emp.page.getByText('Pending approval').first()).toBeVisible();
  await expect(emp.page.getByText('Clock paused')).toBeVisible();

  const mgr = await signIn(browser, USERS.manager, 'en');
  await mgr.page.goto('/reviews');
  const card = reviewCard(mgr.page, title);
  await expect(card.getByText('Installed and tested')).toBeVisible();
  // Image attachments are previewed in place: the thumbnail really renders the stored image…
  const thumb = card.getByRole('button', { name: 'Preview handover.png' });
  await expect(thumb.locator('img')).toBeVisible();
  // Thumbnails are loading="lazy": scroll the card into view (the shared inbox may hold older items above it).
  await thumb.scrollIntoViewIfNeeded();
  await expect.poll(() => thumb.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  // …and opens in an in-app viewer (no download needed).
  await thumb.click();
  const viewer = mgr.page.getByRole('dialog', { name: 'handover.png' });
  await expect(viewer.locator('img')).toBeVisible();
  // Full-screen overlay (not clipped by an animated card).
  const box = (await viewer.boundingBox())!;
  const vp = mgr.page.viewportSize()!;
  expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, vp.width, vp.height]);
  await mgr.page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(mgr.page.getByText('Task approved')).toBeVisible();
  await expect(reviewCard(mgr.page, title)).toHaveCount(0);

  await mgr.page.goto(`/tasks/${id}`);
  await expect(mgr.page.getByText('Final — completed on time')).toBeVisible();
  await expect(mgr.page.getByText('Submissions & decisions')).toBeVisible();
  await mgr.page.goto(`/projects/${f.towerId}?tab=documents`);
  await mgr.page.getByRole('textbox', { name: 'Search documents…' }).fill('handover');
  await mgr.page.getByRole('button', { name: 'Search' }).click();
  await expect(mgr.page.getByText('From approved task', { exact: true }).first()).toBeVisible();
  await expect(mgr.page.getByRole('link', { name: title })).toBeVisible();
  // Employees never see managers-only deliverables, in the UI or via the API.
  await emp.page.goto(`/projects/${f.towerId}?tab=documents`);
  await expect(emp.page.getByRole('link', { name: title })).toHaveCount(0);
  const docs = await call(f.mgr, 'GET', `/projects/${f.towerId}/documents?taskId=${id}`);
  expect((await call(f.emp, 'GET', `/documents/${docs.body.items[0].id}/download-url`)).status).toBe(404);
  await mgr.context.close();
  await emp.context.close();
});

test('7. rejection requires a reason; the employee sees it, the task is listed as sent back, and can resubmit', async ({ browser }) => {
  test.setTimeout(90_000);
  const f = await fixtures();
  const title = `Reject ${tag()}`;
  const id = await createTask(title);
  expect((await call(f.emp, 'POST', `/tasks/${id}/submissions`, { comment: 'first attempt' })).status).toBe(201);
  const mgr = await signIn(browser, USERS.manager, 'en');
  await mgr.page.goto('/reviews');
  const card = reviewCard(mgr.page, title);
  await card.getByRole('button', { name: 'Reject' }).click();
  const confirmReject = card.getByRole('button', { name: 'Reject' });
  await expect(confirmReject).toBeDisabled();
  await card.getByRole('textbox', { name: 'Reason' }).fill('Photos of the panel are missing');
  await confirmReject.click();
  await expect(mgr.page.getByText('Submission rejected')).toBeVisible();

  const emp = await signIn(browser, USERS.employee, 'en');
  await emp.page.goto(`/tasks/${id}`);
  await expect(emp.page.getByText('Your submission was rejected by Mona Manager')).toBeVisible();
  await expect(emp.page.getByText('Photos of the panel are missing').first()).toBeVisible();
  await emp.page.goto('/tasks?view=rejected');
  await expect(emp.page.getByRole('link', { name: title }).first()).toBeVisible();
  await submitViaUi(emp.page, id, 'Second attempt with photos');
  await mgr.context.close();
  await emp.context.close();
});

test('9/10/11/12. transfer chain: A transfers to B (confirmed), B accepts and submits, A forwards, the manager approves', async ({ browser }) => {
  test.setTimeout(150_000);
  const title = `Chain ${tag()}`;
  const id = await createTask(title);
  const a = await signIn(browser, USERS.employee, 'en');
  await a.page.goto(`/tasks/${id}`);
  await a.page.getByRole('combobox', { name: 'Colleague' }).selectOption({ label: 'Sara Employee' });
  await a.page.getByRole('textbox', { name: 'Reason (required)' }).first().fill('Needs electrical certification');
  await a.page.getByRole('button', { name: 'Request transfer' }).click();
  const dialog = a.page.getByRole('alertdialog');
  await expect(dialog).toContainText('Transfer this task to Sara Employee?');
  await dialog.getByRole('button', { name: 'Request transfer' }).click();
  await expect(a.page.getByText('Transfer requested')).toBeVisible();

  const b = await signIn(browser, USERS.otherEmployee, 'en');
  await b.page.goto('/transfers');
  const req = b.page.locator('li').filter({ has: b.page.getByRole('link', { name: title }) });
  await expect(req.getByText('Needs electrical certification')).toBeVisible();
  await req.getByRole('button', { name: 'Accept' }).click();
  await expect(b.page.getByText('Transfer accepted')).toBeVisible();
  await submitViaUi(b.page, id, 'Wiring certified and done');

  await a.page.goto('/reviews');
  const card = reviewCard(a.page, title);
  await expect(card.getByText('Delegated work')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0); // a delegator cannot approve
  await card.getByRole('button', { name: 'Forward for approval' }).click();
  await expect(a.page.getByText('Forwarded for approval')).toBeVisible();

  const mgr = await signIn(browser, USERS.manager, 'en');
  await mgr.page.goto('/reviews');
  await reviewCard(mgr.page, title).getByRole('button', { name: 'Approve' }).click();
  await expect(mgr.page.getByText('Task approved')).toBeVisible();
  await mgr.page.goto(`/tasks/${id}`);
  await expect(mgr.page.getByText('Omar Employee → Sara Employee')).toBeVisible();
  await expect(mgr.page.getByText('Time by responsible employee')).toBeVisible();
  await expect(mgr.page.getByText('Sara Employee').first()).toBeVisible();
  for (const x of [a, b, mgr]) await x.context.close();
});

test('13/14. extension: employee requests 4h; manager grants 2h; original and approved deadlines both shown', async ({ browser }) => {
  test.setTimeout(90_000);
  const title = `Extend ${tag()}`;
  const id = await createTask(title, 24);
  const emp = await signIn(browser, USERS.employee, 'en');
  await emp.page.goto(`/tasks/${id}`);
  await emp.page.getByRole('spinbutton', { name: 'Extra hours' }).fill('4');
  await emp.page.getByRole('textbox', { name: 'Reason (required)' }).last().fill('Material delivery delayed');
  await emp.page.getByRole('button', { name: 'Request extension' }).click();
  await expect(emp.page.getByText('Extension requested', { exact: true })).toBeVisible();

  const mgr = await signIn(browser, USERS.manager, 'en');
  await mgr.page.goto(`/tasks/${id}`);
  await expect(mgr.page.getByText('Material delivery delayed').first()).toBeVisible();
  await mgr.page.getByRole('spinbutton', { name: 'Grant hours' }).fill('2');
  await mgr.page.getByRole('button', { name: 'Approve partially' }).click();
  await expect(mgr.page.getByText('Extension partially approved')).toBeVisible();
  const history = mgr.page.locator('section').filter({ hasText: 'Deadline extensions' });
  await expect(history.getByText('Partially approved')).toBeVisible();
  await expect(history.getByText('granted 2h')).toBeVisible();
  await expect(history.getByText(/Original deadline/)).toBeVisible();
  await mgr.context.close();
  await emp.context.close();
});

test('16. personal tasks: create, edit, search, complete, delete — private to the owner', async ({ browser }) => {
  const title = `Dentist ${tag()}`;
  const emp = await signIn(browser, USERS.employee, 'en');
  await emp.page.goto('/personal');
  await emp.page.getByRole('button', { name: 'New personal task' }).click();
  await emp.page.getByRole('textbox', { name: 'Title' }).fill(title);
  await emp.page.getByRole('textbox', { name: 'Notes' }).fill('Bring the insurance card');
  await emp.page.getByRole('button', { name: 'Save' }).click();
  await expect(emp.page.getByText('Personal task added')).toBeVisible();
  const row = emp.page.locator('li').filter({ hasText: title });
  await row.getByRole('button', { name: 'Edit' }).click();
  await emp.page.getByRole('textbox', { name: 'Title' }).fill(`${title} (moved)`);
  await emp.page.getByRole('button', { name: 'Save' }).click();
  await expect(emp.page.getByText(`${title} (moved)`)).toBeVisible();
  await emp.page.getByRole('textbox', { name: 'Search' }).fill('insurance');
  await emp.page.getByRole('button', { name: 'Search' }).click();
  await expect(emp.page.getByText(`${title} (moved)`)).toBeVisible();
  await emp.page.locator('li').filter({ hasText: title }).getByRole('button', { name: 'Mark as done' }).click();
  await emp.page.getByRole('tab', { name: 'Done' }).click();
  await expect(emp.page.getByText(`${title} (moved)`)).toBeVisible();

  // Nobody else sees it — not the manager, not the admin, not in company task lists.
  for (const who of [USERS.manager, USERS.admin]) {
    const { token } = await apiToken(who);
    const list = await call(token, 'GET', '/me/personal-tasks?status=DONE&pageSize=100');
    expect(JSON.stringify(list.body)).not.toContain(title);
  }
  const { token } = await apiToken(USERS.employee);
  expect(JSON.stringify((await call(token, 'GET', '/tasks?pageSize=100')).body)).not.toContain(title);

  await emp.page.locator('li').filter({ hasText: title }).getByRole('button', { name: 'Delete' }).click();
  await emp.page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(emp.page.getByText('Deleted')).toBeVisible();
  await emp.context.close();
});

test('17. reports: manager generates an Arabic task PDF (rendered by the worker); employee self-report never includes ratings', async ({ browser }) => {
  test.setTimeout(150_000);
  const f = await fixtures();
  const title = `Report ${tag()}`;
  const id = await createTask(title);
  const sub = await call(f.emp, 'POST', `/tasks/${id}/submissions`, { comment: 'done for report' });
  expect((await call(f.mgr, 'POST', `/submissions/${sub.body.id}/approve`, {})).status).toBe(200);
  expect((await call(f.mgr, 'PUT', `/tasks/${id}/rating`, { stars: 5, feedback: 'excellent' })).status).toBe(200);

  const mgr = await signIn(browser, USERS.manager, 'en');
  await mgr.page.goto('/reports');
  await mgr.page.getByRole('textbox', { name: 'Find a task' }).fill(title);
  await mgr.page.getByRole('combobox', { name: 'Task', exact: true }).selectOption({ label: `${title} · Riyadh Office Tower` });
  await mgr.page.getByRole('combobox', { name: 'Report language' }).selectOption('ar');
  await mgr.page.getByRole('button', { name: 'Generate PDF' }).click();
  await expect(mgr.page.getByText('Report requested. You will be notified when it is ready.')).toBeVisible();
  const first = mgr.page.getByRole('list').last().locator('li').first();
  await expect(first.getByText('Ready')).toBeVisible({ timeout: 90_000 });
  await expect(first.getByText('includes private ratings')).toBeVisible();
  const reports = (await call(f.mgr, 'GET', '/me/reports')).body as Array<{ id: string; status: string }>;
  const dl = await call(f.mgr, 'GET', `/reports/${reports[0]!.id}/download-url`);
  const pdf = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

  const emp = await signIn(browser, USERS.employee, 'en');
  await emp.page.goto('/reports');
  await emp.page.getByRole('tab', { name: 'My report' }).click();
  await emp.page.getByRole('button', { name: 'Generate PDF' }).click();
  await expect(emp.page.getByText('Report requested. You will be notified when it is ready.')).toBeVisible();
  const mine = (await call(f.emp, 'GET', '/me/reports')).body as Array<{ includesRatings: boolean }>;
  expect(mine.every((r) => r.includesRatings === false)).toBe(true);
  await expect(emp.page.getByText('includes private ratings')).toHaveCount(0);
  await mgr.context.close();
  await emp.context.close();
});

test('Arabic is the default and the new workspaces render RTL; switching language keeps the current page', async ({ browser }) => {
  const emp = await signIn(browser, USERS.employee, 'ar');
  for (const [path, heading] of [
    ['/personal', 'المهام الشخصية'],
    ['/transfers', 'التحويلات الواردة'],
    ['/reports', 'التقارير'],
    ['/documents', 'المستندات'],
  ] as const) {
    await emp.page.goto(path);
    await expect(emp.page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(emp.page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  await emp.page.goto('/personal');
  await emp.page.getByRole('button', { name: 'English' }).click();
  await expect(emp.page).toHaveURL(/\/personal$/);
  await expect(emp.page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(emp.page.getByRole('heading', { level: 1, name: 'Personal tasks' })).toBeVisible();
  await emp.page.getByRole('button', { name: 'العربية' }).click(); // restore the profile preference
  await expect(emp.page.locator('html')).toHaveAttribute('dir', 'rtl');
  await emp.context.close();
  expect(PASSWORD).toBeTruthy();
});
