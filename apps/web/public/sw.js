/* DailyTasks service worker.
 *
 * Caching policy (deliberately conservative — this app shows private, per-user data):
 *   - Pages (navigations): always network. When offline, the static /offline.html shell is shown.
 *     Authenticated HTML is never cached, so nothing leaks between users of a shared device.
 *   - /bff, /session, /health: never intercepted (API data and auth always go to the network).
 *   - /_next/static/*: cache-first. Files are content-hashed and immutable.
 *   - Icons, manifest, offline page: stale-while-revalidate.
 *   - Cross-origin requests (S3 pre-signed URLs): never intercepted.
 *
 * Bump VERSION when this file's precache list or policy changes. Push handlers arrive with the
 * Web Push migration (see docs/PWA.md).
 */
const VERSION = 'v1';
const SHELL_CACHE = `dt-shell-${VERSION}`;
const STATIC_CACHE = `dt-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest'];
const MAX_STATIC_ENTRIES = 300;
const BYPASS = [/^\/bff(\/|$)/, /^\/session(\/|$)/, /^\/health$/, /^\/sw\.js$/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
      for (const key of await caches.keys()) if (key.startsWith('dt-') && !keep.has(key)) await caches.delete(key);
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    await cache.put(request, res.clone());
    void trim(STATIC_CACHE, MAX_STATIC_ENTRIES);
  }
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok && res.type === 'basic') void cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return hit ?? (await network) ?? Response.error();
}

async function navigate(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match(OFFLINE_URL)) ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS.some((re) => re.test(url.pathname))) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (PRECACHE.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
