import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Password123!';
export const API = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';
export const USERS = {
  manager: 'manager1@dailytasks.local',
  employee: 'employee1@dailytasks.local',
  otherEmployee: 'employee2@dailytasks.local',
  admin: 'admin@dailytasks.local',
};

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
/** Session per user, reused across tests (the API allows 10 logins/min per client IP — by design). */
const sessions = new Map<string, StorageState>();

/**
 * Signs in through the real login form the first time per user, then reuses that session.
 * `locale` pins the UI language via the saved preference cookie.
 */
export async function signIn(browser: Browser, email: string, locale: 'ar' | 'en' = 'en', viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const saved = sessions.get(email);
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), ...(saved ? { storageState: saved } : {}) });
  await context.addCookies([{ name: 'dt_locale', value: locale, url: 'http://localhost:3001' }]);
  const page = await context.newPage();
  if (saved) {
    await page.goto('/');
    if (!page.url().includes('/login')) return { context, page };
  }
  await page.goto('/login');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await expect(page).not.toHaveURL(/\/login/);
  const state = await context.storageState();
  sessions.set(email, { ...state, cookies: state.cookies.filter((c) => c.name !== 'dt_locale') });
  return { context, page };
}

/** Direct API token (for setup / authorization probes). */
export async function apiToken(email: string): Promise<{ token: string; user: { id: string; managedProjectIds: string[] } }> {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const b = await r.json();
  return { token: b.accessToken, user: b.user };
}

/** No element may make the page scroll sideways. */
export async function expectNoHorizontalOverflow(page: Page) {
  const { doc, vw } = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  expect(doc, `page is ${doc}px wide in a ${vw}px viewport`).toBeLessThanOrEqual(vw + 1);
}
