/* Al-Rasiyat (الراسيات) service worker.
 *
 * Caching policy (deliberately conservative — this app shows private, per-user data):
 *   - Pages (navigations): always network. When offline, the static /offline.html shell is shown.
 *     Authenticated HTML is never cached, so nothing leaks between users of a shared device.
 *   - /bff, /session, /health: never intercepted (API data and auth always go to the network).
 *   - /_next/static/*: cache-first. Files are content-hashed and immutable.
 *   - Icons, manifest, offline page: stale-while-revalidate.
 *   - Cross-origin requests (S3 pre-signed URLs): never intercepted.
 *
 * Web Push: `push` shows an OS notification for every message (required: userVisibleOnly; Safari
 * revokes subscriptions that receive pushes without a notification), `notificationclick` focuses
 * or opens the app on the task, `pushsubscriptionchange` re-registers a renewed subscription.
 * Payload format: PushPayload in packages/shared-types.
 *
 * Bump VERSION when this file's precache list or policy changes. A new worker activates at once
 * (skipWaiting); that is safe because no HTML is cached and the push handlers are stateless.
 */
const VERSION = 'v3';
const SHELL_CACHE = `dt-shell-${VERSION}`;
const STATIC_CACHE = `dt-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icon.svg', '/brand/logo-mark.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png', '/apple-touch-icon.png', '/manifest.webmanifest'];
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
  if (PRECACHE.includes(url.pathname) || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/* ------------------------------- Web Push ------------------------------- */

/** Only same-origin in-app paths are ever opened (a payload can't redirect to another site). */
function safePath(url, taskId) {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) return url;
  if (typeof taskId === 'string' && /^[0-9a-f-]{36}$/i.test(taskId)) return `/tasks/${taskId}`;
  return '/notifications';
}

async function setBadge(count) {
  try {
    if (typeof count !== 'number' || !self.navigator.setAppBadge) return;
    if (count > 0) await self.navigator.setAppBadge(count);
    else await self.navigator.clearAppBadge();
  } catch {
    /* unsupported */
  }
}

async function windows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        data = { body: event.data ? event.data.text() : '' };
      }
      const path = safePath(data.url, data.taskId);
      // Let open windows refresh notification lists and badges right away.
      for (const c of await windows()) c.postMessage({ type: 'dt:push', notificationId: data.notificationId, taskId: data.taskId });
      await setBadge(data.badgeCount);
      // Always display: every push must produce a user-visible notification.
      await self.registration.showNotification(data.title || 'الراسيات', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        // Same tag = same notification: a retried push replaces instead of stacking.
        tag: data.tag || (data.notificationId ? `n-${data.notificationId}` : undefined),
        renotify: false,
        requireInteraction: data.requireInteraction === true,
        timestamp: Date.now(),
        dir: 'auto',
        data: { path, notificationId: data.notificationId || null, taskId: data.taskId || null },
      });
    })(),
  );
});

/** Asks an open window to navigate in-app (keeps app state); resolves false if it doesn't answer. */
function askToNavigate(client, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 800);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    client.postMessage({ type: 'dt:navigate', path }, [channel.port2]);
  });
}

async function markRead(notificationId) {
  if (!notificationId) return;
  try {
    await fetch(`/bff/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST', credentials: 'same-origin' });
    const res = await fetch('/bff/notifications/unread-count', { credentials: 'same-origin' });
    if (res.ok) await setBadge((await res.json()).count);
  } catch {
    /* offline or signed out: the in-app list still shows it */
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const path = safePath(d.path, d.taskId);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const read = markRead(d.notificationId);
      const open = (await windows()).filter((c) => new URL(c.url).origin === self.location.origin);
      // Prefer the focused window, then any window of the app.
      const client = open.find((c) => c.focused) || open[0];
      if (client) {
        try {
          await client.focus();
        } catch {
          /* focus may be refused; still navigate */
        }
        if (await askToNavigate(client, path)) return read;
        if ('navigate' in client) {
          try {
            await client.navigate(target);
            return read;
          } catch {
            /* uncontrolled client: fall through */
          }
        }
      }
      await self.clients.openWindow(target);
      return read;
    })(),
  );
});

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The browser rotated or expired the subscription: register the new one with the server. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const json = { 'Content-Type': 'application/json' };
      let sub = event.newSubscription;
      if (!sub) {
        const res = await fetch('/bff/push/vapid-public-key', { credentials: 'same-origin' });
        const { publicKey } = await res.json();
        if (!publicKey) return;
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      }
      await fetch('/bff/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: json, body: JSON.stringify(sub.toJSON()) });
      if (event.oldSubscription && event.oldSubscription.endpoint !== sub.endpoint) {
        await fetch('/bff/push/unsubscribe', { method: 'DELETE', credentials: 'same-origin', headers: json, body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }) });
      }
    })().catch(() => {
      /* the app re-syncs the subscription on next launch */
    }),
  );
});
