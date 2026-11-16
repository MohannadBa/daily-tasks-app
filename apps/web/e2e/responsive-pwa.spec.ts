import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, signIn, USERS } from './helpers';

const PAGES = ['/', '/tasks', '/projects', '/notifications', '/settings', '/settings/notifications', '/employees'];

test.describe('responsive layout', () => {
  for (const locale of ['ar', 'en'] as const) {
    test(`phone (390px) ${locale}: no horizontal overflow, bottom tab bar, touch-sized controls`, async ({ browser }) => {
      const { context, page } = await signIn(browser, USERS.manager, locale, { width: 390, height: 844 });
      for (const path of PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
      }
      await expect(page.getByRole('navigation', { name: locale === 'ar' ? 'التنقل الرئيسي' : 'Main' })).toBeVisible();
      const tab = await page.getByRole('navigation', { name: locale === 'ar' ? 'التنقل الرئيسي' : 'Main' }).locator('a').first().boundingBox();
      expect(tab!.height).toBeGreaterThanOrEqual(44);
      await context.close();
    });
  }

  test('tablet (820px) and desktop (1280px) layouts', async ({ browser }) => {
    for (const width of [820, 1280]) {
      const { context, page } = await signIn(browser, USERS.manager, 'ar', { width, height: 1000 });
      for (const path of PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
      }
      if (width >= 1024) await expect(page.locator('aside').first()).toBeVisible();
      await context.close();
    }
  });
});

test.describe('PWA', () => {
  test('manifest, brand theme, icons and service worker', async ({ page, request }) => {
    const manifest = await (await request.get('/manifest.webmanifest')).json();
    expect(manifest).toMatchObject({ short_name: 'الراسيات', lang: 'ar', dir: 'rtl', display: 'standalone', start_url: '/', theme_color: '#c0903d' });
    for (const icon of manifest.icons as Array<{ src: string }>) {
      const r = await request.get(icon.src);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()['content-type']).toBe('image/png');
    }
    expect((await request.get('/apple-touch-icon.png')).status()).toBe(200);
    const sw = await request.get('/sw.js');
    expect(sw.headers()['cache-control']).toMatch(/no-store/);
    expect(sw.headers()['service-worker-allowed']).toBe('/');

    await page.goto('/login');
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#c0903d');
    const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
    expect(scope).toBe('http://localhost:3001/');
  });

  test('offline: deep link shows the branded offline page, then recovers', async ({ browser }) => {
    const { context, page } = await signIn(browser, USERS.employee, 'ar');
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // controlled by the service worker
    await context.setOffline(true);
    await page.goto('/tasks?view=overdue').catch(() => undefined);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('لا يوجد اتصال بالإنترنت');
    await expect(page).toHaveURL(/\/tasks\?view=overdue/);
    await context.setOffline(false);
    // The offline page reloads itself on the "online" event; fall back to a manual reload.
    await page.waitForURL(/\/tasks\?view=overdue/);
    await expect(async () => {
      await page.goto('/tasks?view=overdue');
      await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('لا يوجد اتصال بالإنترنت');
    }).toPass({ timeout: 20_000 });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('لا يوجد اتصال بالإنترنت');
    // Private API responses are never cached by the service worker.
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const urls = (await Promise.all(keys.map(async (k) => (await (await caches.open(k)).keys()).map((r) => r.url)))).flat();
      // Only content-hashed static assets and public brand files may be cached — never pages or API data.
      return urls.filter((u) => {
        const path = new URL(u).pathname;
        return !path.startsWith('/_next/static/') && !path.startsWith('/icons/') && !path.startsWith('/brand/') && !['/offline.html', '/icon.svg', '/apple-touch-icon.png', '/manifest.webmanifest'].includes(path);
      });
    });
    expect(cached).toEqual([]);
    await context.close();
  });
});
